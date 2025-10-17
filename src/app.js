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
app.set("trust proxy", 1); // needed on Render / Nginx / AWS ELB setups

/* ─────────────────────────────── SECURITY HEADERS ────────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allow serving /uploads to other origins
    contentSecurityPolicy: false,     // loosened for frontend asset compatibility
  })
);

/* ─────────────────────────────────── CORS ────────────────────────────────────── */
const DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.APP_ORIGINS
    ? process.env.APP_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
    : []),
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || DEV_ORIGINS.includes(origin)) cb(null, true);
      else cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Intent",
      "X-Requested-With",
    ],
    exposedHeaders: ["Content-Length", "Content-Type"],
    maxAge: 86400,
  })
);
app.options("*", cors({ origin: DEV_ORIGINS, credentials: true }));

/* ───────────────────────────── LOGGING & PARSERS ─────────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────── STATIC FILES ───────────────────────────────── */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

/* ─────────── Defensive: normalize accidental /api/api/... → /api/... ────────── */
app.use((req, _res, next) => {
  req.url = req.url.replace(/\/api\/api(\/|$)/g, "/api$1");
  next();
});

/* ─────────────────────────────────── ROUTES ──────────────────────────────────── */
/** Health */
app.get("/api/health", (_, res) =>
  res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() })
);

/** Upload (POST /api/upload, GET /api/upload/ping) */
app.use("/api/upload", uploadRoutes);

/** Public/basic routes */
app.use("/api/auth", authRoutes);
app.use("/api/movies", moviesRoutes);
app.use("/api/showtimes", showtimesRoutes);
app.use("/api/theaters", theatersRouter);
app.use("/api/tickets", ticketRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);

/** Notifications + prefs (SSE route: /api/notifications/stream) */
app.use("/api/notifications", notificationsRoutes);
app.use("/api/notification-prefs", notificationPrefRoutes);

/** Profiles */
app.use("/api/profile", profileRoutes);

/** Admin routes (locked down with auth + admin check) */
app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);

/** ✅ Admin alias for theaters for frontend convenience (/api/admin/theaters/...) */
app.use("/api/admin/theaters", requireAuth, requireAdmin, theatersRouter);

/** Screens (explicit prefix for clarity) */
app.use("/api/screens", screensRoutes);
// Optional dual mount for legacy /api/... screen endpoints
app.use("/api", screensRoutes);

/** Protected analytics */
app.use("/api/analytics", requireAuth, requireAdmin, analyticsRoutes);

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
