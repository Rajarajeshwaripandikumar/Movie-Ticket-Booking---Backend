// backend/src/middleware/ownership.js
// Compatibility shim for older imports expecting `middleware/ownership.js`.
// Re-exports canonical helpers from auth.js and scope.js.

import { requireTheatreOwnership as _requireTheatreOwnership } from "./auth.js";
import { isSuperOrOwner as _isSuperOrOwner, getTheatreId as _getTheatreId } from "./scope.js";

export const requireTheatreOwnership = (req, res, next) => {
  if (typeof _requireTheatreOwnership === "function")
    return _requireTheatreOwnership(req, res, next);
  return res.status(500).json({ message: "Ownership middleware not available" });
};

// 🔥 American spelling alias (needed!)
export const requireTheaterOwnership = requireTheatreOwnership;

// Older alias
export const requireOwnership = requireTheatreOwnership;

// Helpers
export const isSuperOrOwner = _isSuperOrOwner;
export const getTheatreId = _getTheatreId;

// Default export (backward compatibility)
export default {
  requireTheatreOwnership,
  requireTheaterOwnership,
  requireOwnership,
  isSuperOrOwner,
  getTheatreId,
};
