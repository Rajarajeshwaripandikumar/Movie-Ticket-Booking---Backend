// backend/src/app.js
import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

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
import ticketRoutes from "./routes/ticket.routes.js";
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

const app = express();

app.set("trust proxy", 1);

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
    if (norm.startsWith("http://localhost") || norm.startsWith("http://127.0.0.1")) return true;

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

/* ------------------------- DEBUG ORIGINS ------------------------- */
app.use((req, _res, next) => {
  console.debug(`[CORS-DBG] ${req.method} ${req.path} origin: ${req.headers.origin || "(none)"}`);
  next();
});

/* ------------------------- STRONG PREFLIGHT ------------------------- */
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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Idempotency-Key, X-Intent, X-Requested-With, x-role, X-Role, Accept"
  );
  res.setHeader("Access-Control-Max-Age", "600");
  return res.sendStatus(204);
});

/* ------------------------- GLOBAL CORS MIRROR ------------------------- */
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

/* ------------------------- CORS LIB ------------------------- */
app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
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

/* ---------------------- Notifications no-cache ---------------------- */
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

// Public/basic routes
app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/movies", moviesRoutes);
app.use("/api/showtimes", showtimesRoutes);
app.use("/api/theaters", theatersRouter);
app.use("/api/theatres", theatersRouter);
app.use("/api/tickets", ticketRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);

if (process.env.NODE_ENV !== "production") {
  app.use("/_debug", debugMailRoutes);
}

app.use("/api/orders", ordersRouter);
app.use("/api/profile", profileRoutes);

app.use("/api/notifications", notificationsRoutes);
app.use("/api/notification-prefs", notificationPrefRoutes);

/* -------------------------------------------------------------------------- */
/* ADMIN: /api/admin/theaters */
/* -------------------------------------------------------------------------- */
app.get(
  "/api/admin/theaters",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"),
  async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const myId = req.user?.theatreId || req.user?.theaterId || null;

      const filter = role === "SUPER_ADMIN" ? {} : { _id: myId };

      const list = await Theater.find(filter).sort({ createdAt: -1 }).lean();

      // Return a consistent response shape expected by the frontend
      return res.json({ ok: true, data: list });
    } catch (err) {
      console.error("[/api/admin/theaters] ERROR:", err);
      return res.status(500).json({ ok: false, message: "Failed to load theaters" });
    }
  }
);

/* -------------------------------------------------------------------------- */
app.use("/api/admin", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN", "ADMIN"), adminRoutes);

/* -------------------------------------------------------------------------- */
app.use("/api", screensRoutes);

/* -------------------------------------------------------------------------- */
app.use("/api/pricing", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), pricingRoutes);

/* -------------------------------------------------------------------------- */
app.use("/api/superadmin", requireAuth, requireRoles("SUPER_ADMIN"), superAdminRoutes);

/* -------------------------------------------------------------------------- */
app.use("/api/analytics", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), analyticsRoutes);

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
