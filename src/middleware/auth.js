// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/**
 * Middleware: Verify JWT and attach user info to req.user
 * Ensures req.user._id and req.user.sub are ALWAYS strings (to match SSE map keys).
 */
export const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing Authorization header" });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Pick a canonical user id (prefer the JWT 'sub')
    const rawId = decoded.sub ?? decoded.id ?? decoded._id ?? decoded.userId;
    if (!rawId) {
      return res.status(401).json({ message: "Token missing subject (sub)" });
    }
    const userId = String(rawId); // <- normalize to string

    // Normalize role for consistent downstream checks
    const rawRole =
      decoded.role ??
      (Array.isArray(decoded.roles) ? decoded.roles[0] : null) ??
      (decoded.isAdmin ? "admin" : "user");

    const normalizedRole = rawRole ? String(rawRole).toLowerCase() : "user";

    // Attach verified user to req (ids as strings)
    req.user = {
      _id: userId,
      id: userId,         // convenience alias
      sub: userId,        // keep sub aligned for SSE/debug
      email: decoded.email || null,
      name: decoded.name || decoded.fullName || null,
      role: normalizedRole,
    };

    // Optional: handy for controllers/logs
    res.locals.userId = userId;

    // Debug (safe to remove later)
    console.log("[Auth] OK", { id: userId, email: req.user.email, role: normalizedRole });

    next();
  } catch (err) {
    console.error("[Auth] Invalid token:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

/**
 * Middleware: Allow only admin users
 */
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
