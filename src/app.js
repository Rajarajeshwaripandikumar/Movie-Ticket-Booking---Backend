import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose"; // For ObjectId validation

import Theater from "./models/Theater.js";

// ROUTES
import authRoutes from "./routes/auth.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import moviesRoutes from "./routes/movies.routes.js";
import showtimesRoutes from "./routes/showtimes.routes.js";
import bookingsRoutes from "./routes/bookings.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import ticketsRoutes from "./routes/tickets.routes.js";
import theatersRouter from "./routes/theaters.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import notificationPrefRoutes from "./routes/notificationPref.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import screensRoutes from "./routes/screens.routes.js";
import pricingRoutes from "./routes/pricing.routes.js";
import debugMailRoutes from "./routes/debug-mail.js";
import ordersRouter from "./routes/orders.routes.js";
import superAdminRoutes from "./routes/superadmin.routes.js";

import { requireAuth, requireRoles } from "./middleware/auth.js";

// 🔔 SSE
import { sseHandler, ssePreflight } from "./socket/sse.js";

const app = express();

app.set("trust proxy", 1);

/* -------------------------------------------------------------------------- */
/* 🔧 DISABLE ETag + NO-CACHE FOR /api ROUTES                                  */
/* -------------------------------------------------------------------------- */
app.disable("etag");

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
    delete req.headers["if-none-match"]; // prevent 304 behavior
  }
  next();
});

/* -------------------------------------------------------------------------- */
/* SECURITY HEADERS */
/* -------------------------------------------------------------------------- */
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  })
);

/* -------------------------------------------------------------------------- */
/* CORS CONFIG */
/* -------------------------------------------------------------------------- */

const DEV_ORIGINS = [
  process.env.APP_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const PROD_ORIGINS = [
  "https://movieticketbooking-rajy.netlify.app",
  "https://movie-ticket-booking-backend-o1m2.onrender.com",
];

const ALLOWED_ORIGINS = Array.from(new Set([...DEV_ORIGINS, ...PROD_ORIGINS]));

console.log("[CORS] Allowed origins:", ALLOWED_ORIGINS);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const norm = `${u.protocol}//${u.host}`;

    if (ALLOWED_ORIGINS.includes(norm)) return true;
    if (norm.endsWith(".netlify.app")) return true;
    if (norm.startsWith("http://localhost") || norm.startsWith("http://127.0.0.1"))
      return true;

    console.warn("[CORS] ❌ Blocked origin:", norm);
    return false;
  } catch (e) {
    console.warn("[CORS] Invalid origin:", origin);
    return false;
  }
}

app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

// CORS Debug
app.use((req, _res, next) => {
  console.debug(
    `[CORS-DBG] ${req.method} ${req.path} origin: ${
      req.headers.origin || "(none)"
    }`
  );
  next();
});

// Strong preflight
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();

  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(origin)) return res.sendStatus(403);

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD"
  );
  // 🔥 include x-idempotency-key here
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "x-idempotency-key",
      "X-Intent",
      "X-Requested-With",
      "x-role",
      "X-Role",
      "Accept",
    ].join(", ")
  );
  res.setHeader("Access-Control-Max-Age", "600");
  return res.sendStatus(204);
});

// Global CORS response
app.use((req, res, next) => {
  try {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "null");
      res.setHeader("Access-Control-Allow-Credentials", "false");
    }
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type, ETag");
  } catch (e) {
    console.warn("[CORS-MIRROR] failed:", e.message);
  }
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    // 🔥 keep cors() in sync with preflight
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "x-idempotency-key",
      "X-Intent",
      "X-Requested-With",
      "x-role",
      "X-Role",
      "Accept",
    ],
    exposedHeaders: ["Content-Length", "Content-Type", "ETag"],
  })
);

/* -------------------------------------------------------------------------- */
/* LOGGING + PARSERS */
/* -------------------------------------------------------------------------- */
app.use(morgan("dev"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

/* -------------------------------------------------------------------------- */
/* STATIC UPLOADS */
/* -------------------------------------------------------------------------- */
const isRender = !!process.env.RENDER;
const uploadsPath = path.resolve(
  process.env.UPLOADS_DIR || (isRender ? "/tmp/uploads" : "uploads")
);
fs.mkdirSync(uploadsPath, { recursive: true });

app.use("/uploads", express.static(uploadsPath, { maxAge: "1d", etag: true }));

/* -------------------------------------------------------------------------- */
/* FIX DOUBLE /api/api and /api/theatres */
/* -------------------------------------------------------------------------- */
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

// Compat aliases for theatre/admin showtimes/movies/screens
app.use((req, _res, next) => {
  // /api/theatre/showtimes → /api/showtimes
  if (req.url.startsWith("/api/theatre/showtimes")) {
    req.url = req.url.replace(/^\/api\/theatre\/showtimes\b/, "/api/showtimes");
  }

  // /api/admin/showtimes → /api/showtimes
  if (req.url.startsWith("/api/admin/showtimes")) {
    req.url = req.url.replace(/^\/api\/admin\/showtimes\b/, "/api/showtimes");
  }

  // ❌ no longer rewrite /api/theatre/movies → /api/movies,
  // because we want /api/theatre/movies to hit theatersRouter (theatre-scoped movies)

  // /api/admin/movies → /api/movies
  if (req.url.startsWith("/api/admin/movies")) {
    req.url = req.url.replace(/^\/api\/admin\/movies\b/, "/api/movies");
  }

  // ✅ /api/theatre/screens → /api/theatre/me/screens
  if (req.url.startsWith("/api/theatre/screens")) {
    req.url = req.url.replace(
      /^\/api\/theatre\/screens\b/,
      "/api/theatre/me/screens"
    );
  }

  next();
});

// Notifications should not be cached
app.use((req, res, next) => {
  if (
    req.path === "/api/notifications/mine" ||
    /^\/api\/notifications\/[^/]+\/read$/.test(req.path)
  ) {
    res.setHeader("Cache-Control", "no-store, no-cache");
  }
  next();
});

/* -------------------------------------------------------------------------- */
/* ROUTES */
/* -------------------------------------------------------------------------- */

app.get("/", (_req, res) => res.send("API running"));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/movies", moviesRoutes);
app.use("/api/showtimes", showtimesRoutes);

// 🎯 THEATERS (canonical + compat)
app.use("/api/theaters", theatersRouter); // main prefix
app.use("/api/theatre", theatersRouter); // compat for /api/theatre/* calls

app.use("/api/tickets", ticketsRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);

if (process.env.NODE_ENV !== "production") {
  app.use("/_debug", debugMailRoutes);
}

app.use("/api/orders", ordersRouter);
app.use("/api/profile", profileRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/notification-prefs", notificationPrefRoutes);

// 🔔 SSE stream for live notifications
app.options("/api/notifications/stream", ssePreflight);
app.get("/api/notifications/stream", sseHandler);

/* ADMIN THEATER ROUTES */
const adminTheatersHandler = async (req, res) => {
  try {
    const role = String(req.user?.role || "").toUpperCase();
    const myId = req.user?.theatreId || req.user?.theaterId || null;

    const filter = role === "SUPER_ADMIN" ? {} : { _id: myId };

    const list = await Theater.find(filter).sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, data: list });
  } catch (err) {
    console.error("[/api/admin/theaters] ERROR:", err);
    return res.status(500).json({ ok: false, message: "Failed to load theaters" });
  }
};

app.get(
  "/api/admin/theaters",
  requireAuth(),
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"),
  adminTheatersHandler
);
app.get(
  "/api/admin/theatres",
  requireAuth(),
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"),
  adminTheatersHandler
);

app.use(
  "/api/admin",
  requireAuth(),
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"),
  adminRoutes
);

app.use("/api", screensRoutes);

app.use(
  "/api/pricing",
  requireAuth(),
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  pricingRoutes
);

app.use(
  "/api/superadmin",
  requireAuth(),
  requireRoles("SUPER_ADMIN"),
  superAdminRoutes
);

app.use(
  "/api/analytics",
  requireAuth(),
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  analyticsRoutes
);

/* -------------------------------------------------------------------------- */
/* 404 HANDLER */
/* -------------------------------------------------------------------------- */
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ message: "Not Found", path: req.path });
  }
  return res.send("Not Found");
});

/* -------------------------------------------------------------------------- */
/* GLOBAL ERROR HANDLER WITH CORS */
/* -------------------------------------------------------------------------- */
app.use((err, req, res, next) => {
  console.error("💥 Error:", err);

  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "null");
  }

  res.status(err.status || 500).json({
    message: err.message || "Internal Server Error",
  });
});

export default app;
