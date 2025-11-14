// backend/src/middleware/scope.js
import mongoose from "mongoose";
import { ROLE } from "./auth.js";   // ← ensures same canonical roles everywhere

/* -------------------------------------------------------------------------- */
/* Utility: normalize role match                                              */
/* -------------------------------------------------------------------------- */
function normalizeRole(v) {
  if (!v) return ROLE.USER;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, "_");
  if (s === "SUPER-ADMIN" || s === "SUPERADMIN" || s === "OWNER") return ROLE.SUPER_ADMIN;
  if (s === "ADMIN") return ROLE.ADMIN;
  if (
    s === "THEATER_ADMIN" ||
    s === "THEATRE_ADMIN" ||
    s === "MANAGER" ||
    s === "PVR_ADMIN" ||
    s === "PVR_MANAGER"
  ) return ROLE.THEATRE_ADMIN;
  return s;
}

/* -------------------------------------------------------------------------- */
/* SUPER_ADMIN or OWNER equivalent                                            */
/* -------------------------------------------------------------------------- */
export function isSuperOrOwner(user) {
  const role = normalizeRole(user?.role);
  return role === ROLE.SUPER_ADMIN;
}

/* -------------------------------------------------------------------------- */
/* Extract theatreId safely from user                                         */
/* -------------------------------------------------------------------------- */
export function getTheatreId(user) {
  const tid =
    user?.theatreId ??
    user?.theaterId ??
    null;

  if (!tid) return null;

  try {
    return new mongoose.Types.ObjectId(String(tid));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Middleware: require the user to have a scoped theatre                      */
/* SUPER_ADMIN → always allowed                                               */
/* THEATRE_ADMIN → must have theatreId                                        */
/* -------------------------------------------------------------------------- */
export function requireScopedTheatre(req, res, next) {
  if (isSuperOrOwner(req.user)) return next();

  const role = normalizeRole(req.user?.role);
  const tid = getTheatreId(req.user);

  if (role === ROLE.THEATRE_ADMIN) {
    if (!tid) {
      return res
        .status(403)
        .json({ message: "Your admin account is not linked to any theatre" });
    }
    req.scope = { theatreId: tid };
    return next();
  }

  // Regular USERS are not allowed to use theatre-scoped admin APIs
  return res.status(403).json({ message: "Forbidden: Theatre admin access only" });
}

/* -------------------------------------------------------------------------- */
/* Assertion helper for controllers                                           */
/* Ensures resource belongs to THEATRE_ADMIN theatre                          */
/* SUPER_ADMIN always allowed                                                 */
/* Throws an actual error (so try/catch works)                                */
/* -------------------------------------------------------------------------- */
export function assertInScopeOrThrow(resourceTheatreId, req) {
  if (isSuperOrOwner(req.user)) return;

  const role = normalizeRole(req.user?.role);
  const tid = getTheatreId(req.user);

  // Only theatre admins check scope
  if (role !== ROLE.THEATRE_ADMIN) {
    const err = new Error("Forbidden: Admin role required");
    err.status = 403;
    throw err;
  }

  if (!tid || String(tid) !== String(resourceTheatreId)) {
    const err = new Error("Forbidden: Outside your theatre scope");
    err.status = 403;
    throw err;
  }
}
