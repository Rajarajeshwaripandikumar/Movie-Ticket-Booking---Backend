// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/* --------------------------------- helpers -------------------------------- */
function normalizeRole(raw) {
  if (raw === undefined || raw === null) return "USER";
  try {
    const v = String(raw).trim().toUpperCase().replace(/\s+/g, "_");

    // Canonicalization map
    const map = {
      // Super admin aliases
      ADMIN: "SUPER_ADMIN",
      SUPERUSER: "SUPER_ADMIN",

      // Theatre admin / manager variants
      THEATRE_ADMIN: "THEATER_ADMIN",   // UK -> US spelling
      THEATRE_MANAGER: "THEATER_ADMIN",
      THEATER_MANAGER: "THEATER_ADMIN",
      PVR_MANAGER: "THEATER_ADMIN",
      PVR_ADMIN: "THEATER_ADMIN",
      MANAGER: "THEATER_ADMIN",
    };

    return map[v] ?? v;
  } catch {
    return "USER";
  }
}

function normalizeRoleList(xs) {
  if (!xs) return [];
  if (Array.isArray(xs)) return xs.map(normalizeRole);
  return [normalizeRole(xs)];
}

/* -------------------------------------------------------------------------- */
/* 🧩 Middleware: Verify JWT and attach user info                              */
/* -------------------------------------------------------------------------- */
export const requireAuth = (req, res, next) => {
  // ✅ Never block CORS preflight (lets the browser proceed to the real request)
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  try {
    let token = null;

    // 1️⃣ Authorization header (Bearer)
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)) {
      token = authHeader.replace(/^Bearer\s+/i, "").trim();
    }

    // 2️⃣ Cookie fallback (only relevant if you actually set cookies)
    if (!token && req.cookies?.token) {
      token = String(req.cookies.token);
    }

    // 3️⃣ Query param (allowed only in non-production OR for /stream endpoints)
    if (
      !token &&
      req.query?.token &&
      (process.env.NODE_ENV !== "production" || (req.path && req.path.includes("/stream")))
    ) {
      token = String(req.query.token);
    }

    if (!token) {
      return res.status(401).json({ message: "Missing Authorization token" });
    }

    // 🔐 Verify and decode
    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = String(
      decoded.sub ?? decoded.id ?? decoded._id ?? decoded.userId ?? decoded.user?.id ?? ""
    );
    if (!userId) {
      return res.status(401).json({ message: "Token missing subject (sub/id)" });
    }

    // derive a single canonical role
    const rawRole =
      decoded.role ??
      (Array.isArray(decoded.roles) ? decoded.roles[0] : null) ??
      (decoded.isAdmin ? "ADMIN" : "USER");

    const role = normalizeRole(rawRole);

    // accept both theatreId/theaterId from token, but expose both on req.user
    const theatreId =
      decoded.theatreId ??
      decoded.theatre?.id ??
      decoded.theaterId ??
      decoded.theater?.id ??
      null;

    req.user = {
      _id: userId,
      id: userId,
      email: decoded.email || null,
      name: decoded.name || decoded.fullName || null,
      role,                                      // USER | THEATER_ADMIN | SUPER_ADMIN
      theatreId: theatreId ? String(theatreId) : null,
      theaterId: theatreId ? String(theatreId) : null,
    };

    // convenient local
    res.locals.userId = userId;

    next();
  } catch (err) {
    console.error("[Auth] Invalid token:", err && (err.message || err));
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

/* -------------------------------------------------------------------------- */
/* 🛡️ Middleware: Require specific roles                                       */
/* Accepts either multiple args or a single array                              */
/* -------------------------------------------------------------------------- */
export const requireRoles = (...allowedArgs) => {
  const allowed = Array.isArray(allowedArgs[0]) ? allowedArgs[0] : allowedArgs;
  const normalizedAllowed = allowed.map(normalizeRole);

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized (no user)" });
    }
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
/* THEATER_ADMIN can only manage their own theatre; SUPER_ADMIN bypasses       */
/* -------------------------------------------------------------------------- */
export const requireTheatreOwnership = (req, res, next) => {
  const targetTheatreId =
    req.body?.theatreId ??
    req.params?.theatreId ??
    req.query?.theatreId ??
    req.body?.theaterId ??
    req.params?.theaterId ??
    req.query?.theaterId;

  const user = req.user;
  const role = normalizeRole(user?.role);

  // SUPER_ADMIN can manage any theatre
  if (role === "SUPER_ADMIN") return next();

  // THEATER_ADMIN must have a theatreId and match target
  const myId = user?.theatreId || user?.theaterId;
  if (
    role === "THEATER_ADMIN" &&
    myId &&
    targetTheatreId &&
    String(myId) === String(targetTheatreId)
  ) {
    return next();
  }

  return res.status(403).json({ message: "Forbidden — you can only manage your own theatre" });
};

/* -------------------------------------------------------------------------- */
/* Backwards-compatible aliases and convenience guards                         */
/* -------------------------------------------------------------------------- */

// Any admin flavour (SUPER_ADMIN or THEATER_ADMIN)
export const requireAdmin = requireRoles("SUPER_ADMIN", "THEATER_ADMIN", "ADMIN");

// Explicit
export const requireSuperAdmin = requireRoles("SUPER_ADMIN");
export const requireTheatreAdmin = requireRoles("THEATER_ADMIN"); // UK/US spelling normalized internally
