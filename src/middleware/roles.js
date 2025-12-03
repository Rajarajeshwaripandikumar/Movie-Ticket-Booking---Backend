// backend/src/middleware/roles.js
// Thin compatibility layer around auth.js so older imports keep working.

import {
  requireAuth as baseRequireAuth,
  requireRoles,
  requireAdmin as baseRequireAdmin,
  requireTheatreOwnership as baseRequireTheatreOwnership,
  ROLE,
} from "./auth.js";

/* -------------------------------------------------------------------------- */
/*  Auth wrappers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * requireAuth(opts?)
 * Just forwards to auth.js implementation
 */
export function requireAuth(opts = {}) {
  return baseRequireAuth(opts);
}

/**
 * requireRole(...roles)
 *
 * Backwards-compatible alias for requireRoles from auth.js.
 * Supports:
 *   requireRole("THEATER_ADMIN", "SUPER_ADMIN")
 *   requireRole(["THEATRE_ADMIN", "SUPER_ADMIN"])
 */
export function requireRole(...roles) {
  return requireRoles(...roles);
}

/**
 * requireAdmin(opts)
 * Wrapper over auth.js requireAdmin
 */
export function requireAdmin(opts = {}) {
  return baseRequireAdmin(opts);
}

/* -------------------------------------------------------------------------- */
/*  Theatre-scoped helpers (kept from old roles.js)                           */
/* -------------------------------------------------------------------------- */

/**
 * getTheatreId(req) - best-effort extraction of theatre id from user object
 */
export function getTheatreId(req) {
  if (!req || !req.user) return null;
  return (
    req.user.theatreId ||
    req.user.theaterId ||
    req.user.theatre ||
    req.user.theater ||
    null
  );
}

/**
 * isTheatreScopedRole(req) -> true if user's role is theatre-scoped
 */
export function isTheatreScopedRole(req) {
  const role = String(req.user?.role || "").toUpperCase();
  return role.includes("THEATRE") || role.includes("THEATER");
}

/**
 * requireScopedTheatre middleware - marks theatre-scoped users
 */
export function requireScopedTheatre(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  req._isTheatreScoped = isTheatreScopedRole(req);
  next();
}

/**
 * assertInScopeOrThrow(theatreId, req)
 * Throws 401/403 if user is not allowed to operate on this theatre.
 */
export function assertInScopeOrThrow(theatreId, req) {
  if (!req?.user) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  const role = String(req.user.role || "").toUpperCase();

  // SUPER_ADMIN / ADMIN: global
  if (role === ROLE.SUPER_ADMIN || role === ROLE.ADMIN) return;

  // THEATRE_ADMIN: must match own theatre
  if (role === ROLE.THEATRE_ADMIN) {
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

/* -------------------------------------------------------------------------- */
/*  Theatre ownership middleware (re-exported from auth.js)                   */
/* -------------------------------------------------------------------------- */

/**
 * requireTheaterOwnership
 * (kept name as US spelling for backwards compatibility)
 */
export const requireTheaterOwnership = baseRequireTheatreOwnership;

/* -------------------------------------------------------------------------- */
/*  Default export for convenience                                            */
/* -------------------------------------------------------------------------- */

export default {
  requireAuth,
  requireRole,
  requireAdmin,
  getTheatreId,
  isTheatreScopedRole,
  requireScopedTheatre,
  assertInScopeOrThrow,
  requireTheaterOwnership,
  ROLE,
};
