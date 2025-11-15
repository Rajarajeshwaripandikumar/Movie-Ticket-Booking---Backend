// backend/src/middleware/ownership.js
// Compatibility shim for older imports that expect `middleware/ownership.js`.
// Re-exports the canonical helpers from auth.js and scope.js so both old and
// new code paths work without touching many files.

import { requireTheatreOwnership as _requireTheatreOwnership } from "./auth.js";
import { isSuperOrOwner as _isSuperOrOwner, getTheatreId as _getTheatreId } from "./scope.js";

/**
 * Named exports:
 *  - requireTheatreOwnership(req,res,next)  -> middleware (same shape as original)
 *  - requireOwnership(req,res,next)         -> alias for requireTheatreOwnership
 *  - isSuperOrOwner(user)                   -> role helper
 *  - getTheatreId(user)                     -> helper
 *
 * Default export keeps backwards-compatibility with `import ownership from './ownership'`
 */
export const requireTheatreOwnership = (req, res, next) => {
  // if the auth middleware exported the function, call it directly
  if (typeof _requireTheatreOwnership === "function") return _requireTheatreOwnership(req, res, next);
  // otherwise, fail safe
  return res.status(500).json({ message: "Ownership middleware not available" });
};

// alias historically used in some codebases
export const requireOwnership = requireTheatreOwnership;

// small helpers re-export
export const isSuperOrOwner = _isSuperOrOwner;
export const getTheatreId = _getTheatreId;

export default {
  requireTheatreOwnership,
  requireOwnership,
  isSuperOrOwner,
  getTheatreId,
};
