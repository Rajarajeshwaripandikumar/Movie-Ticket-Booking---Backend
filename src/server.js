import dotenv from "dotenv";
dotenv.config();

import http from "http";
import mongoose from "mongoose";
import cors from "cors";

// SSE helpers (watchers + handler for notifications)
import sse from "./socket/sse.js";

// Fully-configured Express app (all routes/middleware live here)
import app from "./app.js";

/* ------------------------- Startup route audit (log) ------------------------ */
// Prefix-aware audit so you know if essentials are mounted
function getAllRoutes(appInstance) {
  const out = [];
  const stack = appInstance?._router?.stack || [];
  for (const layer of stack) {
    if (layer.route?.path) {
      out.push(layer.route.path);
      continue;
    }
    if (layer?.name === "router" && layer?.handle?.stack) {
      for (const r of layer.handle.stack) {
        if (r?.route?.path) out.push(r.route.path);
      }
    }
  }
  return out;
}

function routePrefixExists(appInstance, prefix) {
  try {
    const stack = appInstance?._router?.stack || [];
    for (const layer of stack) {
      if (layer?.route?.path && String(layer.route.path).startsWith(prefix)) return true;
      if (layer?.name === "router" && layer?.handle?.stack) {
        for (const r of layer.handle.stack) {
          if (r?.route?.path && String(r.route.path).startsWith(prefix)) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function auditRoutes(appInstance, { failOnMissing = false } = {}) {
  const mustHavePrefixes = [
    "/api/health",
    "/api/auth",
    "/api/movies",
    "/api/showtimes",
    "/api/theaters",
    "/api/theatres",
    "/api/tickets",
    "/api/bookings",
    "/api/payments",
    "/api/orders",
    "/api/screens",
    "/api/pricing",
    "/api/profile",
    "/api/notifications",
    "/api/notification-prefs",
    "/api/superadmin",
    "/api/admin",
    "/api/analytics",
    "/uploads",
  ];

  const routes = getAllRoutes(appInstance);
  console.log(`🧭 Route audit: discovered ~${routes.length} concrete route paths`);
  let missing = 0;
  for (const p of mustHavePrefixes) {
    const ok = routePrefixExists(appInstance, p);
    console.log(`${ok ? "✅" : "❌"} ${p}`);
    if (!ok) missing++;
  }
  if (missing > 0) {
    const msg = `Route audit: ${missing} required prefix(es) missing. Check imports/mounts in app.js`;
    if (failOnMissing) {
      console.error(msg);
      process.exit(1);
    } else {
      console.warn(msg);
    }
  } else {
    console.log("✅ Route audit: all required prefixes present");
  }
}
auditRoutes(app, { failOnMissing: false });

/* ----------------------------- SSE: Notifications ------------------------- */
// Minimal CORS + SSE headers dedicated to the stream endpoint
function sseCorsHeaders(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-role, X-Role");
  if (req.method === "OPTIONS") return res.sendStatus(204);

  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  }
  next();
}

// Let cors handle preflight so requested headers are reflected properly
app.options("/api/notifications/stream", cors());
app.get("/api/notifications/stream", sseCorsHeaders, sse.sseHandler);

/* ------------------------- MongoDB connect helper ------------------------- */
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI in environment");
  process.exit(1);
}

async function connectWithRetry(uri, maxAttempts = 6) {
  let attempt = 0;
  const baseDelay = 1000;
  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`🔌 MongoDB connect attempt ${attempt}/${maxAttempts}...`);
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 30_000,
      });
      console.log("✅ MongoDB connected");
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`MongoDB connect attempt ${attempt} failed: ${msg}`);
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(30_000, baseDelay * 2 ** attempt);
      console.log(`⏳ Retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/* ----------------------------- Server boot -------------------------------- */
const PORT = Number(process.env.PORT) || 8080;
let server;
let shuttingDown = false;

async function start() {
  try {
    app.locals.dbReady = false;
    server = http.createServer(app);

    // SSE-friendly timeouts
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 2 * 60 * 60 * 1000;
    server.maxRequestsPerSocket = 0;

    server.on("connection", (socket) => {
      try {
        socket.setKeepAlive(true, 30_000);
        socket.setNoDelay(true);
      } catch {}
    });

    server.listen(PORT, () => {
      console.log(`🚀 API listening on port ${PORT} (env=${process.env.NODE_ENV || "development"})`);
    });

    mongoose.connection.on("error", (err) => console.error("MongoDB error:", err));
    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB disconnected");
      app.locals.dbReady = false;
    });
    mongoose.connection.on("reconnected", () => {
      console.log("MongoDB reconnected");
      app.locals.dbReady = true;
    });

    await connectWithRetry(MONGO_URI, 6);
    app.locals.dbReady = true;
    console.log("✅ MongoDB ready");

    // Start SSE helpers: change-stream watcher + periodic analytics snapshot
    try {
      if (sse && typeof sse.startBookingWatcher === "function") {
        sse.startBookingWatcher();
      } else {
        console.warn("SSE module missing startBookingWatcher — skipping watcher start");
      }

      const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 60_000);
      if (SNAPSHOT_INTERVAL_MS > 0 && typeof sse.emitAnalyticsSnapshot === "function") {
        setInterval(() => {
          sse.emitAnalyticsSnapshot().catch((err) => console.error("emitAnalyticsSnapshot failed", err));
        }, SNAPSHOT_INTERVAL_MS);
      }
      console.log("SSE helpers started: booking watcher + snapshot emitter");
    } catch (err) {
      console.error("Failed starting SSE helpers:", err);
    }
  } catch (err) {
    console.error("❌ Failed to start app:", err);
    process.exit(1);
  }
}

/* ----------------------------- Graceful stop ------------------------------- */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⚠️  Received ${signal} — shutting down...`);
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      await mongoose.disconnect();
      console.log("✅ MongoDB disconnected");
    } catch (e) {
      console.warn("Error disconnecting MongoDB:", e?.message || e);
    }
    console.log("✅ Shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("Shutdown error:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
