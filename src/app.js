// backend/src/index.js
import dotenv from "dotenv";
dotenv.config();

import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

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
import { requireAuth, requireAdmin } from "./middleware/auth.js";

const app = express();

/* ── Core ─────────────────────────────────────────────────────────────────── */
app.set("trust proxy", 1);

const API_PREFIX = (process.env.API_PREFIX || "/api").replace(/\/+$/, "");

/* ── Security / CORS ──────────────────────────────────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  })
);

const DEFAULT_DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const extraOrigins = (process.env.APP_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_DEV_ORIGINS, ...extraOrigins])];

app.use(
  cors({
    origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(null, false)),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposedHeaders: ["Content-Length", "Content-Type"],
    maxAge: 86400,
  })
);
app.options("*", cors());

/* ── Parsers / logging ────────────────────────────────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ── Health ───────────────────────────────────────────────────────────────── */
app.get(`${API_PREFIX}/health`, (req, res) => {
  const ready = !!app.locals.dbReady;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    db: ready ? "up" : "connecting",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/* ── Public static for uploaded files ─────────────────────────────────────── */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads"), { etag: true, lastModified: true }));

/* ── API warm-up guard (does NOT block /uploads) ──────────────────────────── */
app.use((req, res, next) => {
  if (!req.path.startsWith(API_PREFIX)) return next();
  if (req.path === `${API_PREFIX}/health`) return next();
  if (!app.locals.dbReady) return res.status(503).json({ message: "Service warming up, try again shortly." });
  next();
});

/* ── Routes (order matters; mount before 404 handler) ─────────────────────── */
app.use(`${API_PREFIX}/upload`, uploadRoutes);         // <- /api/upload (POST, GET /ping)
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/movies`, moviesRoutes);
app.use(`${API_PREFIX}/showtimes`, showtimesRoutes);
app.use(`${API_PREFIX}/theaters`, theatersRouter);
app.use(`${API_PREFIX}/tickets`, ticketRoutes);
app.use(`${API_PREFIX}/bookings`, bookingsRoutes);
app.use(`${API_PREFIX}/payments`, paymentsRoutes);
app.use(`${API_PREFIX}/notifications`, notificationsRoutes);
app.use(`${API_PREFIX}/notification-prefs`, notificationPrefRoutes);
app.use(`${API_PREFIX}/profile`, profileRoutes);
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/screens`, screensRoutes);
app.use(`${API_PREFIX}/analytics`, requireAuth, requireAdmin, analyticsRoutes);

/* ── Debug: list routes on boot (optional; remove later) ──────────────────── */
function listRoutes(app) {
  const lines = [];
  app._router?.stack?.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      lines.push(`${methods.padEnd(10)} ${m.route.path}`);
    } else if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route) {
          const methods = Object.keys(h.route.methods).join(",").toUpperCase();
          lines.push(`${methods.padEnd(10)} ${m.regexp} -> ${h.route.path}`);
        }
      });
    }
  });
  console.log("[ROUTES]\n" + lines.join("\n"));
}
listRoutes(app);

/* ── 404 for API ──────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  if (req.path.startsWith(API_PREFIX)) return res.status(404).json({ message: "Not Found", path: req.path });
  next();
});

/* ── Error handler ────────────────────────────────────────────────────────── */
app.use((err, req, res, next) => {
  console.error("💥 Uncaught error:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    message: err.message || "Internal Server Error",
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

export default app;
