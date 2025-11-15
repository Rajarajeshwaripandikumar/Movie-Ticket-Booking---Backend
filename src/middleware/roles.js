// backend/src/middleware/roles.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js"; // optional if you need DB lookups

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/**
 * parseToken -> returns decoded or null
 */
export function parseTokenFromHeader(req) {
  const h = req.headers.authorization || req.query?.token || "";
  const token = h?.startsWith?.("Bearer ") ? h.slice(7) : h || null;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

/**
 * requireAuth() -> middleware factory
 * reads token, sets req.user = { _id, email, role, theatreId?, ... }
 */
export function requireAuth() {
  return async function (req, res, next) {
    try {
      const decoded = parseTokenFromHeader(req);
      if (!decoded) return res.status(401).json({ message: "Unauthorized - missing/invalid token" });

      // Support common claim names
      const uid = decoded.sub || decoded.id || decoded.userId || decoded._id;
      const role = (decoded.role || decoded.roles || "USER").toString().toUpperCase();

      // Basic user object on req (you can enrich with DB lookup if needed)
      req.user = {
        _id: uid,
        id: uid,
        email: decoded.email || decoded.mail,
        role,
        // optionally include theatreId stored inside token for THEATRE_ADMIN
        theatreId: decoded.theatreId || decoded.theaterId || decoded.theatre || null,
      };

      next();
    } catch (e) {
      console.error("[requireAuth] error:", e);
      return res.status(401).json({ message: "Unauthorized" });
    }
  };
}

/**
 * requireRole(rolesArray) -> ensures req.user.role is in the allowed set
 * rolesArray may be strings like ["SUPER_ADMIN","THEATRE_ADMIN","USER"]
 */
export function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const role = String(req.user.role || "USER").toUpperCase();
    if (!Array.isArray(roles)) roles = [roles];
    const allowed = roles.map((r) => String(r || "").toUpperCase());
    if (!allowed.includes(role)) return res.status(403).json({ message: "Forbidden" });
    return next();
  };
}

/**
 * requireAdmin(options)
 *  - allowTheatreAdmin: boolean -> if true, a THEATRE_ADMIN is allowed to pass (scoped checks separate)
 * Default: allow only SUPER_ADMIN / ADMIN.
 */
export function requireAdmin(opts = {}) {
  const allowTheatreAdmin = Boolean(opts.allowTheatreAdmin);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const role = String(req.user.role || "").toUpperCase();
    if (role === "SUPER_ADMIN" || role === "ADMIN") return next();
    if (allowTheatreAdmin && role === "THEATRE_ADMIN") return next();
    return res.status(403).json({ message: "Admin role required" });
  };
}

/* ---------------- theatre-scoped helpers ---------------- */

/**
 * getTheatreId(req) - best-effort extraction of theatre id from token or user object
 */
export function getTheatreId(req) {
  if (!req || !req.user) return null;
  return req.user.theatreId || req.user.theatreId || req.user.theaterId || null;
}

/**
 * isTheatreScopedRole(req) -> true if user's role is theatre-scoped
 */
export function isTheatreScopedRole(req) {
  const role = String(req.user?.role || "").toUpperCase();
  return role.includes("THEATRE") || role.includes("THEATER");
}

/**
 * requireScopedTheatre middleware - ensures theatre-admin is not acting out-of-scope.
 * It simply attaches a small flag; prefer using assertInScopeOrThrow where you have theaterId
 */
export function requireScopedTheatre(req, res, next) {
  // no-op if user not a theatre scoped role
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  req._isTheatreScoped = isTheatreScopedRole(req);
  next();
}

/**
 * assertInScopeOrThrow(theatreId, req)
 * throws Error with .status=403 if disallowed; otherwise returns undefined.
 * Use inside async route handlers after requireAuth().
 */
export function assertInScopeOrThrow(theatreId, req) {
  if (!req?.user) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  const role = String(req.user.role || "").toUpperCase();
  if (role === "SUPER_ADMIN" || role === "ADMIN") return; // allowed
  if (role === "THEATRE_ADMIN") {
    const my = String(getTheatreId(req) || "");
    if (!my || String(theatreId) !== my) {
      const err = new Error("Forbidden: out-of-scope theatre");
      err.status = 403;
      throw err;
    }
    return;
  }
  // Regular users cannot perform theatre admin actions
  const err = new Error("Forbidden");
  err.status = 403;
  throw err;
}

/* ---------------- convenience exports ---------------- */
export default {
  requireAuth,
  requireRole,
  requireAdmin,
  isTheatreScopedRole,
  requireScopedTheatre,
  getTheatreId,
  assertInScopeOrThrow,
};
