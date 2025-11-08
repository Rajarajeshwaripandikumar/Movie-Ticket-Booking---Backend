import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// ─────────────────────────────── ROUTES ───────────────────────────────
import authRoutes from "./routes/auth.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import moviesRoutes from "./routes/movies.routes.js";
import showtimesRoutes from "./routes/showtimes.routes.js";
import bookingsRoutes from "./routes/bookings.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import ticketRoutes from "./routes/ticket.routes.js";
import theatersRouter from "./routes/theaters.routes.js"; // US spelling
import notificationsRoutes from "./routes/notifications.routes.js";
import notificationPrefRoutes from "./routes/notificationPref.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import screensRoutes from "./routes/screens.routes.js";
import pricingRoutes from "./routes/pricing.routes.js";
import debugMailRoutes from "./routes/debug-mail.js";
import ordersRouter from "./routes/orders.routes.js";
import superAdminRoutes from "./routes/superadmin.routes.js";

// ─────────────────────────────── MIDDLEWARE ───────────────────────────────
import { requireAuth, requireRoles } from "./middleware/auth.js";

const app = express();

/* ───────────────────────────── CORE APP SETTINGS ─────────────────────────── */
app.set("trust proxy", 1); // Render / ELB / Netlify etc.

/* ───────────────────────────── SECURITY HEADERS ──────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false, // relaxed for dev; tighten in prod if needed
  })
);

/* ─────────────────────────────── CORS CONFIG ─────────────────────────────── */
const DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.APP_ORIGINS
    ? process.env.APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

const PROD_ORIGINS = [
  "https://movieticketbooking-rajy.netlify.app",
  "https://movie-ticket-booking-backend-o1m2.onrender.com",
  ...(process.env.APP_ORIGINS_PROD
    ? process.env.APP_ORIGINS_PROD.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

const ALLOWED_ORIGINS = [...DEV_ORIGINS, ...PROD_ORIGINS];

console.log("[CORS] Allowed origins:", ALLOWED_ORIGINS);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      console.warn("[CORS] ❌ Blocked:", origin);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Intent",
      "X-Requested-With",
      "x-role",
      "X-Role",
    ],
    exposedHeaders: ["Content-Length", "Content-Type"],
    maxAge: 86400,
  })
);

// Preflight handler (mirror the same allow list)
app.options("*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

/* ───────────────────────────── LOGGING & PARSERS ─────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

/* ───────────────────────────── STATIC FILES ──────────────────────────────── */
const uploadsPath = path.resolve(process.env.UPLOADS_DIR || "uploads");
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
app.use("/uploads", express.static(uploadsPath));

console.log("[app] Serving static uploads from:", uploadsPath);
try {
  console.log("[app] Found files:", fs.readdirSync(uploadsPath));
} catch (e) {
  console.warn("[app] Cannot read uploads dir:", e.message);
}

/* ──────────────── FIX DOUBLE /api/api and THEAT(RE)RS ALIAS ─────────────── */
app.use((req, _res, next) => {
  req.url = req.url.replace(/\/api\/api(\/|$)/g, "/api$1");
  next();
});
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/theatres")) {
    req.url = req.url.replace(/^\/api\/theatres\b/, "/api/theaters");
  }
  next();
});

/* ─────────────── Notifications: force no-store to avoid 304s ────────────── */
app.use((req, res, next) => {
  const p = req.path || "";
  if (
    p === "/api/notifications/mine" ||
    /^\/api\/notifications\/[^/]+\/read$/.test(p)
  ) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

/* ─────────────────────────────── ROUTES ─────────────────────────────── */

// Health
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  })
);

// Uploads
app.use("/api/upload", uploadRoutes);

// Public/basic
app.use("/api/auth", authRoutes);
app.use("/api/movies", moviesRoutes);
app.use("/api/showtimes", showtimesRoutes);
app.use("/api/theaters", theatersRouter); // canonical
app.use("/api/theatres", theatersRouter); // alias
app.use("/api/tickets", ticketRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/_debug", debugMailRoutes);
app.use("/api/orders", ordersRouter);

// Pricing (protected for admins)
app.use("/api/pricing", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), pricingRoutes);

// Notifications (REST)
app.use("/api/notifications", notificationsRoutes);
app.use("/api/notification-prefs", notificationPrefRoutes);

// Profiles
app.use("/api/profile", profileRoutes);

// Super Admin
app.use("/api/superadmin", requireAuth, requireRoles("SUPER_ADMIN"), superAdminRoutes);

// Admin (Super Admin & Theatre Admin)
app.use("/api/admin", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), adminRoutes);

/**
 * ⬇️ IMPORTANT: Mount screensRoutes at `/api` (NOT `/api/screens`)
 * The router defines paths beginning with `/admin/theaters/...` and `/theaters/...`
 * so mounting here produces:
 *   /api/admin/theaters/:theaterId/screens
 *   /api/theaters/:theaterId/screens
 *   /api/screens/by-theatre/:id  (kept inside router for compatibility)
 */
app.use("/api", screensRoutes);

/* -------------------------------------------------------------------------- */
/* 🎯 SSE STREAM TOKEN FIX FOR ANALYTICS                                      */
/* -------------------------------------------------------------------------- */
app.use("/api/analytics/stream", (req, _res, next) => {
  try {
    if (!req.headers.authorization && req.query && req.query.token) {
      const tok = String(req.query.token);
      req.headers.authorization = `Bearer ${tok}`;
      console.debug(
        `[PREAUTH] Copied token from query -> Authorization for ${req.originalUrl} (preview: ${tok.slice(0, 8)}...)`
      );
    }
  } catch (e) {
    console.debug("[PREAUTH] Failed to copy token:", e && e.message);
  }
  next();
});

// Analytics (protected)
app.use("/api/analytics", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), analyticsRoutes);

/* ─────────────────────────────── 404 / ERROR ────────────────────────────── */
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ message: "Not Found", path: req.path });
  }
  return next();
});

app.use((err, req, res, next) => {
  console.error("💥 Uncaught error:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    message: err.message || "Internal Server Error",
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

export default app;
