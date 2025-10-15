// src/app.js
import dotenv from "dotenv";
dotenv.config();

import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// routes
import authRoutes from "./routes/auth.routes.js";
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
app.set("trust proxy", 1); // if deployed behind a proxy (nginx/render/etc.)

/* ─────────────────────────────── SECURITY HEADERS ────────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allow images from other origins if needed
    contentSecurityPolicy: false,     // relaxed for dev; tighten in prod if you can
  })
);

/* ─────────────────────────────────── CORS ────────────────────────────────────── */
const DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
];
app.use(
  cors({
    origin: DEV_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Let browser-sent headers pass preflight automatically
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposedHeaders: ["Content-Length", "Content-Type"],
  })
);
// Answer ALL preflights early
app.options("*", cors({ origin: DEV_ORIGINS, credentials: true }));

/* ───────────────────────────── LOGGING & PARSERS ─────────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────── ROUTES ──────────────────────────────────── */
/** Public/basic routes */
app.use("/api/auth", authRoutes);
app.use("/api/movies", moviesRoutes);
app.use("/api/showtimes", showtimesRoutes);
app.use("/api/theaters", theatersRouter);
app.use("/api/tickets", ticketRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);

/** SSE / notifications (mounted early; SSE route is /api/notifications/stream) */
app.use("/api/notifications", notificationsRoutes);

/** Profiles */
app.use("/api/profile", profileRoutes);

/** Admin (all endpoints live under /api/admin/...) */
app.use("/api/admin", adminRoutes);

// (Optional) Legacy alias for older frontend calls like /api/theaters/admin/theaters
// Remove this once the frontend is updated to /api/admin/...
// app.use("/api/theaters/admin", adminRoutes);

/** Screens (explicit prefix so paths are unambiguous) */
app.use("/api/screens", screensRoutes);
// optional dual mount while you migrate
app.use("/api", screensRoutes);


/** Protected analytics */
app.use("/api/analytics", requireAuth, requireAdmin, analyticsRoutes);

/* ─────────────────────────────── STATIC FILES ───────────────────────────────── */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

/* ─────────────────────────────── HEALTH ENDPOINT ─────────────────────────────── */
app.get("/api/health", (_, res) =>
  res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() })
);

/* ────────────────────────────── 404 FALLTHROUGH ──────────────────────────────── */
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
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
