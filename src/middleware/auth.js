// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/**
 * Middleware: Verify JWT and attach user info to req.user
 *
 * Token lookup order:
 *  1. Authorization header "Bearer <token>"
 *  2. req.cookies.token (cookie) - recommended for EventSource (SSE)
 *  3. req.query.token - allowed only for stream endpoints or non-production (to avoid leaking tokens)
 */
export const requireAuth = (req, res, next) => {
  try {
    // 1) Header
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }

    // 2) Cookie (if no Authorization header)
    if (!token) {
      // cookie-parser must be mounted in app.js for req.cookies to exist
      if (req.cookies && req.cookies.token) {
        token = String(req.cookies.token);
      }
    }

    // 3) Query param token — only allow for SSE (`/stream`) or in development
    if (!token && req.query && req.query.token) {
      const allowQuery =
        String(process.env.NODE_ENV || "development") !== "production" ||
        (req.path && req.path.includes("/stream"));
      if (allowQuery) {
        token = String(req.query.token);
      } else {
        // If not allowed, treat as missing
        console.warn("[Auth] Query token present but not allowed in production for this path:", req.path);
      }
    }

    if (!token) {
      return res.status(401).json({ message: "Missing Authorization token" });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);

    const rawId = decoded.sub ?? decoded.id ?? decoded._id ?? decoded.userId;
    if (!rawId) {
      return res.status(401).json({ message: "Token missing subject (sub)" });
    }
    const userId = String(rawId);

    const rawRole =
      decoded.role ??
      (Array.isArray(decoded.roles) ? decoded.roles[0] : null) ??
      (decoded.isAdmin ? "admin" : "user");

    const normalizedRole = rawRole ? String(rawRole).toLowerCase() : "user";

    req.user = {
      _id: userId,
      id: userId,
      sub: userId,
      email: decoded.email || null,
      name: decoded.name || decoded.fullName || null,
      role: normalizedRole,
    };

    res.locals.userId = userId;

    console.log("[Auth] OK", { id: userId, email: req.user.email, role: normalizedRole });

    next();
  } catch (err) {
    console.error("[Auth] Invalid token:", err && err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    console.warn("[Auth] No user on request (requireAuth missing?)");
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (req.user.role !== "admin") {
    console.warn("[Auth] Admin access denied for role:", req.user.role);
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};
