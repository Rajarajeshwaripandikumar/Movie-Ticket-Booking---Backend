// backend/src/app-route-guard.js
import { requireAuth, requireRoles } from "./middleware/auth.js";
import { requireScopedTheatre } from "./middleware/scope.js";
import routePolicies from "./routePolicies.js";

// helper to return array of middlewares from policy
export function middlewaresForPolicy(policy) {
  if (!policy) return [];
  if (policy.public) return [];
  const mws = [];
  if (policy.auth || policy.methods || policy.authToken) {
    mws.push(requireAuth());
  }
  if (policy.roles) {
    mws.push(requireRoles(...policy.roles));
  }
  if (policy.scoped) {
    mws.push(requireScopedTheatre);
  }
  return mws;
}

// Example: mount policy for a specific path
export function applyPolicy(app, path, router) {
  const policy = routePolicies[path] || {};
  const mws = middlewaresForPolicy(policy);
  if (mws.length) app.use(path, ...mws, router);
  else app.use(path, router);
}
