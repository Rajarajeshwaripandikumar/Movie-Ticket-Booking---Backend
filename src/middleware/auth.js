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
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }

    // 2️⃣ Cookie fallback
    if (!token && req.cookies?.token) {
      token = String(req.cookies.token);
    }

    // 3️⃣ Query param (allowed only in non-production)
    if (
      !token &&
      req.query?.token &&
      (process.env.NODE_ENV !== "production" ||
        (req.path && req.path.includes("/stream")))
    ) {
      token = String(req.query.token);
    }

    if (!token)
      return res.status(401).json({ message: "Missing Authorization token" });

    // 🔐 Verify and decode
    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = String(
      decoded.sub ?? decoded.id ?? decoded._id ?? decoded.userId
    );
    if (!userId)
      return res.status(401).json({ message: "Token missing subject (sub)" });

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
      theatreId: decoded.theatreId || null, // carry theatre link for theatre-admins
    };

    res.locals.userId = userId;
    next();
  } catch (err) {
    console.error("[Auth] Invalid token:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

/* -------------------------------------------------------------------------- */
/* 🛡️ Middleware: Require specific roles                                       */
/* Usage: app.post("/admin", requireAuth, requireRoles("SUPER_ADMIN"), handler)*/
/* -------------------------------------------------------------------------- */
export const requireRoles = (...allowed) => {
  return (req, res, next) => {
    if (!req.user)
      return res.status(401).json({ message: "Unauthorized (no user)" });

    const role = req.user.role?.toUpperCase?.() || "USER";
    if (!allowed.includes(role)) {
      console.warn("[Auth] Access denied for role:", role, "allowed:", allowed);
      return res
        .status(403)
        .json({ message: "Access denied — insufficient role" });
    }

    next();
  };
};

/* -------------------------------------------------------------------------- */
/* 🎭 Middleware: Require theatre ownership                                    */
/* Ensures a theatre-admin can only edit their own theatre                    */
/* -------------------------------------------------------------------------- */
export const requireTheatreOwnership = (req, res, next) => {
  const targetTheatreId = req.body.theatreId || req.params.theatreId;
  const user = req.user;

  if (user.role === "SUPER_ADMIN") return next();
  if (
    user.role === "THEATRE_ADMIN" &&
    user.theatreId &&
    String(user.theatreId) === String(targetTheatreId)
  ) {
    return next();
  }

  return res
    .status(403)
    .json({ message: "Forbidden — you can only manage your own theatre" });
};
