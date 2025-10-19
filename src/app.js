// backend/src/app.js
import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// Routes
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

// Middleware
import { requireAuth, requireAdmin } from "./middleware/auth.js";

const app = express();

/* ─────────────────────────────── CORE APP SETTINGS ───────────────────────────── */
app.set("trust proxy", 1); // Render / Netlify / ELB

/* ─────────────────────────────── SECURITY HEADERS ────────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allow /uploads cross-origin
    contentSecurityPolicy: false,     // relaxed for dev (tighten in prod)
  })
);

/* ─────────────────────────────────── CORS ────────────────────────────────────── */
const DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.APP_ORIGINS
    ? process.env.APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

const PROD_ORIGINS = [
  "https://movieticketbooking-rajy.netlify.app",            // frontend
  "https://movie-ticket-booking-backend-o1m2.onrender.com", // backend self
  ...(process.env.APP_ORIGINS_PROD
    ? process.env.APP_ORIGINS_PROD.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

const ALLOWED_ORIGINS = [...DEV_ORIGINS, ...PROD_ORIGINS];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
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

// Preflight
app.options("*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

/* ───────────────────────────── LOGGING & PARSERS ─────────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────── STATIC FILES ───────────────────────────────── */
// Serve uploaded images
const uploadsPath = path.resolve(process.env.UPLOADS_DIR || "uploads");
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
app.use("/uploads", express.static(uploadsPath));

// Debug log for Render file visibility
console.log("[app] Serving static uploads from:", uploadsPath);
try {
  console.log("[app] Found files:", fs.readdirSync(uploadsPath));
} catch (e) {
  console.warn("[app] Cannot read uploads dir:", e.message);
}

/* ─────────── Defensive: normalize accidental /api/api/... → /api/... ────────── */
app.use((req, _res, next) => {
  req.url = req.url.replace(/\/api\/api(\/|$)/g, "/api$1");
  next();
});

/* ─────────────────────────────────── ROUTES ──────────────────────────────────── */
// Health check
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

// Public/basic routes
app.use("/api/auth", authRoutes);
app.use("/api/movies", moviesRoutes);
app.use("/api/showtimes", showtimesRoutes);
app.use("/api/theaters", theatersRouter);
app.use("/api/tickets", ticketRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);

// Notifications
app.use("/api/notifications", notificationsRoutes);
app.use("/api/notification-prefs", notificationPrefRoutes);

// Profiles
app.use("/api/profile", profileRoutes);

// Admin routes (protected)
app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);
app.use("/api/admin/theaters", requireAuth, requireAdmin, theatersRouter);

// Screens
app.use("/api/screens", screensRoutes);

// Analytics (protected)
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
