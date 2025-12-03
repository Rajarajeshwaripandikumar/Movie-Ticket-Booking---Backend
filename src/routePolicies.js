// backend/src/routePolicies.js
// Canonical mapping of route prefixes -> policy (best-effort from repo)
export const routePolicies = {
  "/api/auth": { public: true },

  "/api/movies": {
    methods: {
      GET: { public: true },
      POST: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },
      PATCH: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },
      DELETE: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },
    },
  },

  "/api/showtimes": {
    GET: { public: true },
    "/my-theatre": { GET: { auth: true } },
    POST: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"], scoped: true },
    PATCH: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"], scoped: true },
    DELETE: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"], scoped: true },
    "/availability": { GET: { public: true } },
    "/cities": { GET: { public: true } },
    "/movies": { GET: { public: true } },
  },

  "/api/screens": {
    GET: { public: true }, // public list/by-theatre endpoints
    "/admin": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"], scoped: true },
    "/screens/by-theatre/:id": { auth: true }, // frontend compatibility
  },

  "/api/theaters": {
    GET: { public: true },
    "/:id": { public: true },
    "/me": { auth: true }, // theatre-admin personal data
    "/admin": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"], scoped: true },
  },

  "/api/pricing": {
    GET: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN"], scoped: true },
    POST: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN"], scoped: true },
    "/bulk": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN"], scoped: true },
    "/matrix": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN"], scoped: true },
  },

  "/api/notifications": {
    "/stream": { authToken: true }, // SSE uses token verification
    "/mine": { auth: true },
    "/unread-count": { auth: true },
    "/:id": { auth: true },
    "/:id/read": { auth: true },
    "/read-all": { auth: true },
    "/notify": { auth: true }, // dev helper — consider restrict to ADMIN
  },

  "/api/notification-prefs": {
    "/me": { auth: true, methods: { GET: { auth: true }, PATCH: { auth: true } } },
  },

  "/api/profile": { auth: true },

  "/api/bookings": {
    POST: { auth: true }, // create booking (user)
    GET: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] }, // admin list
  },

  "/api/tickets": {
    "/:bookingId/download": { auth: true }, // recommend requireAuth() or signed link
  },

  "/api/payments": {
    "/create-order": { public: true },
    "/verify-payment": { public: true },
    "/mock-success": { public: false, devOnly: true },
  },

  "/api/upload": {
    POST: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] }, // controlled by authWrapper
    "/multiple": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },
    DELETE: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },
  },

  "/api/orders": {
    POST: { public: true }, // webhook or frontend order create (in dev)
    GET: { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },
  },

  "/api/superadmin": { auth: true, roles: ["SUPER_ADMIN"] },

  "/api/admin": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"] },

  "/api/analytics": { auth: true, roles: ["SUPER_ADMIN", "THEATRE_ADMIN"] },
};
export default routePolicies;
