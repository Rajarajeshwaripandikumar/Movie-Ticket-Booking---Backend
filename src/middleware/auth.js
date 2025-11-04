// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/* -------------------------------------------------------------------------- */
/* 🧩 Middleware: Verify JWT and attach user info                              */
/* -------------------------------------------------------------------------- */
export const requireAuth = (req, res, next) => {
  try {
    let token = null;

    // 1️⃣ Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }

    // 2️⃣ Cookie fallback
    if (!token && req.cookies?.token) {
      token = String(req.cookies.token);
    }

    // 3️⃣ Query param (allowed only in non-production OR stream endpoints)
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
      decoded.sub ?? decoded.id ?? decoded._id ?? decoded.userId
    );
    if (!userId) {
      return res.status(401).json({ message: "Token missing subject (sub)" });
    }

    const rawRole =
      decoded.role ??
      (Array.isArray(decoded.roles) ? decoded.roles[0] : null) ??
      (decoded.isAdmin ? "ADMIN" : "USER");

    const normalizedRole = rawRole ? String(rawRole).toUpperCase() : "USER";

    req.user = {
      _id: userId,
      id: userId,
      email: decoded.email || null,
      name: decoded.name || decoded.fullName || null,
      role: normalizedRole,
      theatreId: decoded.theatreId ?? decoded.theatre?.id ?? null, // carry theatre link for theatre-admins
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
/* Usage: app.post("/admin", requireAuth, requireRoles("SUPER_ADMIN"), handler)*/
/* Accepts either multiple args or a single array: requireRoles("A","B") or requireRoles(["A","B"]) */
/* -------------------------------------------------------------------------- */
export const requireRoles = (...allowedArgs) => {
  // support requireRoles(["A","B"]) or requireRoles("A","B")
  const allowed = Array.isArray(allowedArgs[0]) ? allowedArgs[0] : allowedArgs;
  const normalized = allowed.map((r) => String(r || "").toUpperCase());

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized (no user)" });
    }

    const role = String(req.user.role || "USER").toUpperCase();
    if (!normalized.includes(role)) {
      console.warn("[Auth] Access denied for role:", role, "allowed:", normalized);
      return res.status(403).json({ message: "Access denied — insufficient role" });
    }

    next();
  };
};

/* -------------------------------------------------------------------------- */
/* 🎭 Middleware: Require theatre ownership                                    */
/* Ensures a theatre-admin can only edit/manage their own theatre              */
/* Example usage:
     router.put("/admin/theaters/:theatreId", requireAuth, requireRoles("SUPER_ADMIN","THEATRE_ADMIN"), requireTheatreOwnership, handler)
   SUPER_ADMIN bypasses this check (has global rights)
   THEATRE_ADMIN must have req.user.theatreId === targetTheatreId
/* -------------------------------------------------------------------------- */
export const requireTheatreOwnership = (req, res, next) => {
  const targetTheatreId = req.body?.theatreId ?? req.params?.theatreId ?? req.query?.theatreId;
  const user = req.user;

  // SUPER_ADMIN can manage any theatre
  if (user?.role === "SUPER_ADMIN") return next();

  // Theatre admin must have theatreId and match target
  if (
    user?.role === "THEATRE_ADMIN" &&
    user.theatreId &&
    String(user.theatreId) === String(targetTheatreId)
  ) {
    return next();
  }

  return res.status(403).json({ message: "Forbidden — you can only manage your own theatre" });
};

/* -------------------------------------------------------------------------- */
/* Backwards-compatible aliases and convenience guards                         */
/* - requireAdmin: old code may import this directly                           */
/* - requireSuperAdmin / requireTheatreAdmin: explicit helpers                 */
/* -------------------------------------------------------------------------- */

// requireAdmin: keep old import working — allow any admin flavour
export const requireAdmin = requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN");

// requireSuperAdmin: explicit single-role helper
export const requireSuperAdmin = requireRoles("SUPER_ADMIN");

// requireTheatreAdmin: explicit single-role helper (does NOT include SUPER_ADMIN)
export const requireTheatreAdmin = requireRoles("THEATRE_ADMIN");
