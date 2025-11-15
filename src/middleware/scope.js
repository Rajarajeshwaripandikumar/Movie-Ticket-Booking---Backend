// backend/src/middleware/scope.js
import mongoose from "mongoose";
import { ROLE } from "./auth.js"; // canonical roles

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
/* - returns a mongoose ObjectId when possible, otherwise null                */
/* -------------------------------------------------------------------------- */
export function getTheatreId(user) {
  const tid = user?.theatreId ?? user?.theaterId ?? null;
  if (!tid) return null;
  try {
    return new mongoose.Types.ObjectId(String(tid));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helper: attach scope helpers (fills multiple convenient fields)            */
/* -------------------------------------------------------------------------- */
function attachScopeToReq(req, tidObj) {
  // tidObj is a mongoose ObjectId
  if (!req) return;
  req.scope = req.scope || {};
  req.scope.theatreId = tidObj;
  // also expose string-friendly variants to match existing code that compares strings
  req.scopeTheatreId = String(tidObj);
  req.scopeTheaterId = String(tidObj);
}

/* -------------------------------------------------------------------------- */
/* Middleware: require the user to have a scoped theatre                      */
/* SUPER_ADMIN → always allowed                                               */
/* THEATRE_ADMIN or ADMIN → must have theatreId                               */
/* -------------------------------------------------------------------------- */
export function requireScopedTheatre(req, res, next) {
  try {
    if (!req?.user) {
      return res.status(401).json({ message: "Unauthorized: no user attached" });
    }

    if (isSuperOrOwner(req.user)) {
      return next();
    }

    const role = normalizeRole(req.user?.role);
    const tid = getTheatreId(req.user);

    // Allow both THEATRE_ADMIN and ADMIN if they have a theatreId assigned
    if (role === ROLE.THEATRE_ADMIN || role === ROLE.ADMIN) {
      if (!tid) {
        return res.status(403).json({ message: "Your admin account is not linked to any theatre" });
      }
      attachScopeToReq(req, tid);
      return next();
    }

    // Regular USERS are not allowed to use theatre-scoped admin APIs
    return res.status(403).json({ message: "Forbidden: Theatre admin access only" });
  } catch (err) {
    console.error("[scope] requireScopedTheatre error:", err);
    return res.status(500).json({ message: "Scope middleware failure" });
  }
}

/* -------------------------------------------------------------------------- */
/* Assertion helper for controllers                                           */
/* Ensures resource belongs to THEATRE_ADMIN/ADMIN theatre                    */
/* SUPER_ADMIN always allowed                                                 */
/* Throws an actual error (so try/catch works)                                */
/* -------------------------------------------------------------------------- */
export function assertInScopeOrThrow(resourceTheatreId, req) {
  // resourceTheatreId may be a string or ObjectId
  if (!req?.user) {
    const err = new Error("Unauthorized: no user attached");
    err.status = 401;
    throw err;
  }

  if (isSuperOrOwner(req.user)) return;

  const role = normalizeRole(req.user?.role);
  const tid = getTheatreId(req.user);

  // Only theatre-level admins (THEATRE_ADMIN or ADMIN) are allowed to check scope here
  if (role !== ROLE.THEATRE_ADMIN && role !== ROLE.ADMIN) {
    const err = new Error("Forbidden: Admin role required");
    err.status = 403;
    throw err;
  }

  if (!tid) {
    const err = new Error("Forbidden: your admin account has no theatre assigned");
    err.status = 403;
    throw err;
  }

  // normalize both to strings for safe comparison
  if (String(tid) !== String(resourceTheatreId)) {
    const err = new Error("Forbidden: Outside your theatre scope");
    err.status = 403;
    throw err;
  }

  // attach scope (helpful for callers that expect req.scope)
  attachScopeToReq(req, tid);
}
