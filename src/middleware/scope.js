// backend/src/middleware/scope.js
import mongoose from "mongoose";

export function isSuperOrOwner(user) {
  const role = String(user?.role || "").toUpperCase();
  return role === "SUPER_ADMIN" || role === "OWNER";
}

export function getTheatreId(user) {
  const tid = user?.theatreId || user?.theaterId;
  if (!tid) return null;
  try {
    return new mongoose.Types.ObjectId(String(tid));
  } catch {
    return null;
  }
}

/**
 * If THEATRE_ADMIN → ensure they have a theatreId.
 * SUPER_ADMIN/OWNER pass through.
 */
export function requireScopedTheatre(req, res, next) {
  if (isSuperOrOwner(req.user)) return next();
  const tid = getTheatreId(req.user);
  if (!tid) {
    return res.status(403).json({ message: "Your account is not linked to a theatre" });
  }
  req.scope = { theatreId: tid };
  next();
}

/**
 * Ensure the resource belongs to THEATRE_ADMIN's theatre.
 * SUPER_ADMIN/OWNER always allowed.
 */
export function assertInScopeOrThrow(resourceTheatreId, req) {
  if (isSuperOrOwner(req.user)) return;
  const tid = getTheatreId(req.user);
  if (!tid || String(tid) !== String(resourceTheatreId)) {
    const err = new Error("Forbidden: Outside your theatre scope");
    err.status = 403;
    throw err;
  }
}
