import dotenv from "dotenv";
dotenv.config();

import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// routes
import authRoutes from "./routes/auth.routes.js";
// + add this import with your other route imports
import uploadRoutes from "./routes/upload.routes.js";

import moviesRoutes from "./routes/movies.routes.js";
import showtimesRoutes from "./routes/showtimes.routes.js";
import bookingsRoutes from "./routes/bookings.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import ticketRoutes from "./routes/ticket.routes.js";
import theatersRouter from "./routes/theaters.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import notificationPrefRoutes from "./routes/notificationPref.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import screensRoutes from "./routes/screens.routes.js";

// middleware
import { requireAuth, requireAdmin } from "./middleware/auth.js";

const app = express();

/* ─────────────────────────────── CORE APP SETTINGS ───────────────────────────── */
app.set("trust proxy", 1); // behind Render/NGINX/Cloudflare

/* ─────────────────────────────── SECURITY HEADERS ────────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allow images/files from other origins
    contentSecurityPolicy: false,    // relax for now; tighten later if possible
  })
);

/* ───────────────────────────── API PREFIX (configurable) ────────────────────── */
// Single source of truth for your API base (align this with frontend VITE_API_PREFIX)
const API_PREFIX = (process.env.API_PREFIX || "/api").replace(/\/+$/, "");

/* ─────────────────────────────────── CORS ────────────────────────────────────── */
// Allow Netlify app + local dev. You can add more origins via APP_ORIGIN, APP_ORIGINS (comma-separated)
const DEFAULT_DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const extraOrigins = (process.env.APP_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_DEV_ORIGINS, ...extraOrigins])];

// ********************************************************************************
// NOTE: To fix the CORS issue, you MUST set the following environment variable
// on your Render backend service:
//
// APP_ORIGINS = https://movieticketbooking-rajy.netlify.app
//
// Your current code is correct but relies on this ENV variable for the Netlify URL.
// ********************************************************************************

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin and tools (no Origin header), and explicit allowlist
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true, // if you ever set withCredentials client-side
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposedHeaders: ["Content-Length", "Content-Type"],
    maxAge: 86400, // cache preflight for 24h
  })
);
// Always respond to preflights quickly
app.options("*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

/* ───────────────────────────── LOGGING & PARSERS ─────────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────── HEALTH & WARMUP GUARD ──────────────────────────── */
// Health reflects DB readiness (server.js toggles app.locals.dbReady)
app.get(`${API_PREFIX}/health`, (req, res) => {
  const ready = !!app.locals.dbReady;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    db: ready ? "up" : "connecting",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Optional: while DB is not ready, fail fast with 503 for API requests (except health)
// This prevents 15s browser timeouts during cold start or DB issues.
app.use((req, res, next) => {
  if (!req.path.startsWith(API_PREFIX)) return next(); // non-API assets, etc.
  if (req.path === `${API_PREFIX}/health`) return next();
  if (!app.locals.dbReady) {
    return res.status(503).json({ message: "Service warming up, try again shortly." });
  }
  return next();
});

/* ─────────────────────────────────── ROUTES ──────────────────────────────────── */
/** Public/basic routes (mounted under API_PREFIX) */
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/movies`, moviesRoutes);
app.use(`${API_PREFIX}/showtimes`, showtimesRoutes);
app.use(`${API_PREFIX}/theaters`, theatersRouter);
app.use(`${API_PREFIX}/tickets`, ticketRoutes);
app.use(`${API_PREFIX}/bookings`, bookingsRoutes);
app.use(`${API_PREFIX}/payments`, paymentsRoutes);

/** SSE / notifications (SSE route is `${API_PREFIX}/notifications/stream`) */
app.use(`${API_PREFIX}/notifications`, notificationsRoutes);

/** Notification preferences (if separate) */
app.use(`${API_PREFIX}/notification-prefs`, notificationPrefRoutes);

/** Profiles */
app.use(`${API_PREFIX}/profile`, profileRoutes);

/** Admin (all endpoints live under `${API_PREFIX}/admin/...`) */
app.use(`${API_PREFIX}/admin`, adminRoutes);

/** Screens (no duplicate mounts to avoid ambiguous paths) */
app.use(`${API_PREFIX}/screens`, screensRoutes);

/** Protected analytics */
app.use(`${API_PREFIX}/analytics`, requireAuth, requireAdmin, analyticsRoutes);

/* ─────────────────────────────── STATIC FILES ───────────────────────────────── */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

/* ────────────────────────────── 404 FALLTHROUGH ─────────────────────────────── */
app.use((req, res, next) => {
  if (req.path.startsWith(API_PREFIX)) {
    return res.status(404).json({ message: "Not Found", path: req.path });
  }
  return next();
});

/* ─────────────────────────────── ERROR HANDLER ───────────────────────────────── */
app.use((err, req, res, next) => {
  console.error("💥 Uncaught error:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    message: err.message || "Internal Server Error",
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

export default app;
