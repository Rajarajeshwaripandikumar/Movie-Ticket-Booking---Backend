// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const AUTH_TRUST_TOKEN = (process.env.AUTH_TRUST_TOKEN || "false").toLowerCase() === "true";

// timeout for DB fetch (ms)
const FETCH_USER_TIMEOUT_MS = Number(process.env.AUTH_USER_FETCH_TIMEOUT_MS || 1500);

/* --------------------------------- Role utils -------------------------------- */

export const ROLE = {
  USER: "USER",
  THEATRE_ADMIN: "THEATRE_ADMIN", // canonical (UK)
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN", // distinct, do NOT escalate to SUPER_ADMIN
};

function normalizeRole(raw) {
  if (raw === undefined || raw === null) return ROLE.USER;
  try {
    const v = String(raw).trim().toUpperCase().replace(/\s+/g, "_");

    if (v === "SUPERUSER" || v === "SUPER-ADMIN") return ROLE.SUPER_ADMIN;

    if (
      v === "THEATER_ADMIN" ||
      v === "THEATER-MANAGER" ||
      v === "THEATRE_MANAGER" ||
      v === "PVR_ADMIN" ||
      v === "PVR_MANAGER" ||
      v === "MANAGER"
    ) {
      return ROLE.THEATRE_ADMIN;
    }

    if (v === "ADMIN") return ROLE.ADMIN;

    if (v in ROLE) return ROLE[v];
    return v;
  } catch {
    return ROLE.USER;
  }
}

function normalizeRoleList(xs) {
  if (!xs) return [];
  if (Array.isArray(xs)) return xs.map(normalizeRole);
  return [normalizeRole(xs)];
}

/* -------------------------------------------------------------------------- */
/* Helper: load authoritative user from DB (deferred import to avoid cycles)  */
/* with a short timeout to avoid hanging requests                             */
/* -------------------------------------------------------------------------- */
async function loadUserFromDbWithTimeout(userId) {
  if (!userId) return null;
  try {
    // deferred import to avoid cycles
    const User = (await import("../models/User.js")).default;
    const p = User.findById(userId).select("+password").lean();
    const t = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("user-fetch-timeout")), Math.max(200, FETCH_USER_TIMEOUT_MS))
    );
    try {
      const result = await Promise.race([p, t]);
      return result || null;
    } catch (e) {
      // timeout or DB error — return null so we fall back to token claims
      console.warn("[Auth] loadUserFromDbWithTimeout fallback:", e?.message || e);
      return null;
    }
  } catch (err) {
    console.warn("[Auth] loadUserFromDbWithTimeout import failed:", err?.message || err);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 🧩 Middleware: Verify JWT and attach user info                              */
/* -------------------------------------------------------------------------- */
export const requireAuth = (opts = {}) => {
  // support using requireAuth() or requireAuth({ forceFresh: true })
  const { forceFresh = false } = typeof opts === "object" ? opts : {};

  return async (req, res, next) => {
    // Never block CORS preflight — let OPTIONS through
    if (req.method === "OPTIONS") {
      // Minimal early return for preflight to avoid auth blocking
      return res.sendStatus(204);
    }

    try {
      let token = null;

      // 1) Authorization header
      const authHeader = req.headers.authorization;
      if (authHeader && typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)) {
        token = authHeader.replace(/^Bearer\s+/i, "").trim();
      }

      // 2) Cookie fallback
      if (!token && req.cookies?.token) {
        token = String(req.cookies.token);
      }

      // 3) Query fallback (development/analytics convenience)
      const isAnalytics = (req.baseUrl && req.baseUrl.includes("/api/analytics"));
      const isStream = (req.path && req.path.includes("/stream"));
      if (
        !token &&
        req.query?.token &&
        (isAnalytics || isStream || process.env.NODE_ENV !== "production")
      ) {
        token = String(req.query.token);
      }

      if (!token) {
        return res.status(401).json({ message: "Missing Authorization token" });
      }

      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        console.error("[Auth] token verify failed:", err && (err.message || err));
        return res.status(401).json({ message: "Invalid or expired token" });
      }

      const userId = String(
        decoded.sub ?? decoded.id ?? decoded._id ?? decoded.userId ?? decoded.user?.id ?? ""
      );
      if (!userId) {
        return res.status(401).json({ message: "Token missing subject (sub/id)" });
      }

      // Prefer authoritative DB values unless explicitly trusting token
      let dbUser = null;
      if (!AUTH_TRUST_TOKEN || forceFresh) {
        dbUser = await loadUserFromDbWithTimeout(userId);
      }

      // raw role & theatre from token
      const rawRoleFromToken =
        decoded.role ?? (Array.isArray(decoded.roles) ? decoded.roles[0] : null) ?? (decoded.isAdmin ? "ADMIN" : null);

      const theatreFromToken =
        decoded.theatreId ?? decoded.theatre?.id ?? decoded.theaterId ?? decoded.theater?.id ?? null;

      // derive final role and theatreId (DB wins if present)
      const finalRole = normalizeRole(dbUser?.role ?? rawRoleFromToken ?? "USER");
      const finalTheatreId = dbUser?.theatreId ?? dbUser?.theaterId ?? theatreFromToken ?? null;

      req.user = {
        _id: userId,
        id: userId,
        email: dbUser?.email ?? decoded.email ?? null,
        name: dbUser?.name ?? decoded.name ?? decoded.fullName ?? null,
        role: finalRole, // canonical role value
        theatreId: finalTheatreId ? String(finalTheatreId) : null,
        theaterId: finalTheatreId ? String(finalTheatreId) : null,
        // include a quiet flag to indicate whether values were loaded from DB
        _fromDb: !!dbUser,
        // attach raw token claims to help debugging if needed
        _claims: process.env.NODE_ENV !== "production" ? decoded : undefined,
      };

      res.locals.userId = userId;
      next();
    } catch (err) {
      console.error("[Auth] requireAuth error:", err && (err.message || err));
      return res.status(401).json({ message: "Unauthorized" });
    }
  };
};

/* -------------------------------------------------------------------------- */
/* 🛡️ Middleware: Require specific roles                                       */
/* -------------------------------------------------------------------------- */
export const requireRoles = (...allowedArgs) => {
  const allowed = Array.isArray(allowedArgs[0]) ? allowedArgs[0] : allowedArgs;
  const normalizedAllowed = normalizeRoleList(allowed);

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized (no user)" });
    const have = normalizeRole(req.user.role);
    if (!normalizedAllowed.includes(have)) {
      console.warn("[Auth] Access denied for role:", have, "allowed:", normalizedAllowed);
      return res.status(403).json({ message: "Access denied — insufficient role" });
    }
    next();
  };
};

/* -------------------------------------------------------------------------- */
/* 🎭 Middleware: Require theatre ownership                                    */
/* -------------------------------------------------------------------------- */
export const requireTheatreOwnership = (req, res, next) => {
  const targetTheatreId =
    req.params?.theatreId ??
    req.params?.theaterId ??
    req.params?.id ??
    req.body?.theatreId ??
    req.body?.theaterId ??
    req.body?.theatre ??
    req.body?.theater ??
    req.query?.theatreId ??
    req.query?.theaterId ??
    req.query?.theatre ??
    req.query?.theater ??
    null;

  const role = normalizeRole(req.user?.role);

  if (role === ROLE.SUPER_ADMIN) return next();

  // THEATRE_ADMIN must match their theatreId
  const myId = req.user?.theatreId || req.user?.theaterId || null;
  if (
    role === ROLE.THEATRE_ADMIN &&
    myId &&
    targetTheatreId &&
    String(myId) === String(targetTheatreId)
  ) {
    return next();
  }

  return res.status(403).json({ message: "Forbidden — you can only manage your own theatre" });
};

/* -------------------------------------------------------------------------- */
/* Convenience guards                                                          */
/* -------------------------------------------------------------------------- */
export const requireAdmin = requireRoles(ROLE.SUPER_ADMIN, ROLE.THEATRE_ADMIN, ROLE.ADMIN);
export const requireSuperAdmin = requireRoles(ROLE.SUPER_ADMIN);
export const requireTheatreAdmin = requireRoles(ROLE.THEATRE_ADMIN);
