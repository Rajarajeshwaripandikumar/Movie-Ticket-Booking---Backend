// backend/src/middleware/ownership.js
// Compatibility shim for older imports expecting `middleware/ownership.js`.
// Re-exports canonical helpers from auth.js and scope.js, and provides a
// factory-style wrapper so callers can do requireTheaterOwnership("id").

import { requireTheatreOwnership as _requireTheatreOwnership } from "./auth.js";
import { isSuperOrOwner as _isSuperOrOwner, getTheatreId as _getTheatreId } from "./scope.js";

/**
 * Plain passthrough middleware (expects (req, res, next)).
 * Keep this for callers that import and use middleware directly:
 *   router.post(..., requireTheatreOwnership, handler)
 */
export const requireTheatreOwnership = (req, res, next) => {
  if (typeof _requireTheatreOwnership === "function") {
    return _requireTheatreOwnership(req, res, next);
  }
  if (!res || typeof res.status !== "function") {
    // defensive: avoid crashing if accidentally invoked at import time
    return next(new Error("Ownership middleware not available"));
  }
  return res.status(500).json({ message: "Ownership middleware not available" });
};

/**
 * Factory wrapper (recommended for route wiring when you want to pass a param key)
 * Usage:
 *   router.post('/theaters/:id/screens', requireTheaterOwnership('id'), handler)
 *
 * This RETURNS middleware — it does NOT call the underlying middleware at import time.
 */
export function requireTheaterOwnership(param = "id") {
  return function (req, res, next) {
    try {
      if (!req || !res) {
        return next(new Error("Invalid request/response in requireTheaterOwnership"));
      }

      // Ensure req.params exists and copy the selected param to theatreId
      if (!req.params) req.params = {};
      if (!req.params.theatreId && req.params[param]) {
        // do not mutate original object reference deeply; shallow assign is fine
        req.params = { ...req.params, theatreId: req.params[param] };
      }

      // Delegate to the canonical middleware (which expects (req,res,next))
      return requireTheatreOwnership(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Backwards-compatible aliases:
 * - requireOwnership (older name)
 * - default export object
 */
export const requireOwnership = requireTheatreOwnership;

// Export helpers through the shim
export const isSuperOrOwner = _isSuperOrOwner;
export const getTheatreId = _getTheatreId;

export default {
  requireTheatreOwnership,
  requireTheaterOwnership,
  requireOwnership,
  isSuperOrOwner,
  getTheatreId,
};
