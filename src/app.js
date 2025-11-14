// backend/src/app.js
import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// ─────────────────────────────── MODELS ───────────────────────────────
import Theater from "./models/Theater.js";

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

/* ─────────────────────────────── CORS CONFIG (UPDATED) ─────────────────────────────── */
const DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.APP_ORIGINS
    ? process.env.APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

const PROD_ORIGINS = [
  "https://movieticketbooking-rajy.netlify.app",
  // usually not required to allow your own backend as an Origin,
  // but harmless to keep:
  "https://movie-ticket-booking-backend-o1m2.onrender.com",
  ...(process.env.APP_ORIGINS_PROD
    ? process.env.APP_ORIGINS_PROD.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

const ALLOWED_ORIGINS = Array.from(new Set([...DEV_ORIGINS, ...PROD_ORIGINS]));
console.log("[CORS] Allowed origins:", ALLOWED_ORIGINS);

/* --------------------------- Robust origin checker ------------------------- */
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser / health checks / server-to-server
  try {
    const u = new URL(origin);
    const norm = `${u.protocol}//${u.host}`; // strip trailing slash

    // exact whitelist
    if (ALLOWED_ORIGINS.includes(norm)) return true;

    // allow any Netlify site (preview domains often vary)
    if (norm.endsWith(".netlify.app")) return true;

    // allow localhost variants
    if (norm.startsWith("http://localhost") || norm.startsWith("http://127.0.0.1")) return true;

    // helpful debug: print blocked origin once
    console.warn("[CORS] Blocking origin not in ALLOWED_ORIGINS:", norm);

    return false;
  } catch (err) {
    console.warn("[CORS] Invalid origin header:", origin, err && err.message);
    return false;
  }
}

// Always vary by Origin so caches don't mix CORS responses
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

/* ------------------ TEMP DEBUG: log incoming Origin headers ----------------- */
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    const origin = req.headers.origin || "(no-origin)";
    console.debug(`[CORS-DBG] ${req.method} ${req.path} Origin: ${origin}`);
    next();
  });
}

// Strong manual preflight that mirrors the Origin and allowed headers/methods
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();

  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(origin)) {
    return res.sendStatus(403);
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD"
  );
  // include lowercase variants and authorization to be extra-tolerant for preflight
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, authorization, Idempotency-Key, X-Intent, X-Requested-With, x-role, X-Role, Accept"
  );
  res.setHeader("Access-Control-Max-Age", "600"); // 10 minutes
  return res.sendStatus(204);
});

// CORS for actual requests (must be BEFORE routes)
app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      console.warn("[CORS] ❌ Blocked:", origin);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Intent",
      "X-Requested-With",
      "x-role",
      "X-Role",
      "Accept",
    ],
    exposedHeaders: ["Content-Length", "Content-Type", "ETag"],
    maxAge: 600,
  })
);

/* ───────────────────────────── LOGGING & PARSERS ─────────────────────────── */
app.use(morgan("dev"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

/* ───────────────────────────── STATIC FILES ──────────────────────────────── */
// Use /tmp on Render by default (project dir is read-only there)
const isRender = !!process.env.RENDER;
const uploadsPath = path.resolve(
  process.env.UPLOADS_DIR || (isRender ? "/tmp/uploads" : "uploads")
);

try {
  fs.mkdirSync(uploadsPath, { recursive: true });
  const stat = fs.lstatSync(uploadsPath);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${uploadsPath}`);

  app.use(
    "/uploads",
    express.static(uploadsPath, { maxAge: "1d", etag: true, fallthrough: true })
  );
  console.log("[app] Serving static uploads from:", uploadsPath);
  try {
    console.log("[app] Found files:", fs.readdirSync(uploadsPath));
  } catch (e) {
    console.warn("[app] Cannot read uploads dir:", e.message);
  }
} catch (e) {
  console.warn("[app] Skipping static /uploads mount:", e.message);
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

// Friendly root to avoid 404 noise
app.get("/", (_req, res) => res.send("✅ Movie Ticket Booking API is running"));

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

if (process.env.NODE_ENV !== "production") {
  app.use("/_debug", debugMailRoutes);
}

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

/**
 * Minimal list endpoint used by AdminScreens.jsx:
 *   GET /api/admin/theaters
 * SUPER_ADMIN → all theaters
 * THEATRE_ADMIN / ADMIN → only their theater (via JWT theatreId/theaterId)
 */
app.get(
  "/api/admin/theaters",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"),
  async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const myId = req.user?.theatreId || req.user?.theaterId;
      const filter = role === "SUPER_ADMIN" ? {} : (myId ? { _id: myId } : { _id: null });
      const list = await Theater.find(filter).sort({ createdAt: -1 }).lean();
      res.json(list);
    } catch (e) {
      console.error("[/api/admin/theaters] error:", e);
      res.status(500).json({ message: "Failed to load theaters" });
    }
  }
);

// Admin (Super Admin, Theatre Admin, and plain Admin)
app.use("/api/admin", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"), adminRoutes);

/**
 * ⬇️ IMPORTANT: Mount screensRoutes at `/api` (NOT `/api/screens`)
 * The router defines paths beginning with `/admin/theaters/...` and `/theaters/...`
 * so mounting here produces:
 *   /api/admin/theaters/:theaterId/screens
 *   /api/theaters/:theaterId/screens
 *   /api/screens/by-theatre/:id  (compat alias inside router)
 */
app.use("/api", screensRoutes);

/* -------------------------------------------------------------------------- */
/* DEV-ONLY: debug public-theaters route (safe — only in non-production)      */
/* -------------------------------------------------------------------------- */
if (process.env.NODE_ENV !== "production") {
  app.get("/_debug/public-theaters", async (_req, res) => {
    try {
      const list = await Theater.find({}).sort({ createdAt: -1 }).lean();
      return res.json(list);
    } catch (e) {
      console.error("[_debug/public-theaters] error:", e && e.message);
      return res.status(500).json({ message: e.message });
    }
  });
}

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
