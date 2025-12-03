// backend/src/server.js
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
/**
 * Express doesn't expose full mount paths for nested routers easily.
 * To keep the audit useful (and avoid false negatives), we:
 *   1) collect every concrete route path we can see,
 *   2) also collect every top-level mount prefix,
 *   3) allow alias checks (e.g., "/api/screens" is satisfied if we see
 *      a mount at "/api" AND any child route that starts with "/screens").
 */

function getAllConcretePaths(appInstance) {
  const out = [];
  const visit = (stack, prefix = "") => {
    if (!Array.isArray(stack)) return;
    for (const layer of stack) {
      // concrete route
      if (layer?.route?.path) {
        const p = prefix + layer.route.path;
        out.push(p);
        continue;
      }
      // nested router
      if (layer?.name === "router" && layer?.handle?.stack) {
        // best effort to extract a readable mount from regexp (Express internals)
        let mount = "";
        try {
          // This grabs the static prefix when possible (e.g., "/api", "/api/auth")
          if (layer?.regexp && layer.regexp.fast_slash !== true) {
            const src = layer.regexp.toString(); // e.g., /^\/api(?:\/(?=$))?$/i
            const match = src.match(/^\/\^\(\\\/\)\?\(\?:\\\/\)\?\.\*$/) ? null : src.match(/^\/\^\\\/([^\\\^$?]*)/);
            if (match && match[1]) {
              mount = "/" + match[1].replace(/\\\//g, "/");
            }
          }
        } catch {}
        visit(layer.handle.stack, prefix + (mount || ""));
      }
    }
  };
  visit(appInstance?._router?.stack || [], "");
  return out;
}

function getTopLevelMounts(appInstance) {
  const out = new Set();
  const stack = appInstance?._router?.stack || [];
  for (const layer of stack) {
    if (layer?.name === "router") {
      // Try to reconstruct a readable mount string from the layer regexp
      let mount = "";
      try {
        if (layer?.regexp && layer.regexp.fast_slash !== true) {
          const src = layer.regexp.toString(); // /^\/api(?:\/(?=$))?$/i  OR /^\/uploads\/?(?=\/|$)/i
          const m = src.match(/^\/\^\\\/(.+?)(?:\\\/\?\(\?=\\\/\|\$\))?\$\//) || src.match(/^\/\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)\/i/);
          if (m && m[1]) mount = "/" + m[1].replace(/\\\//g, "/");
        }
      } catch {}
      // Fallback: if we couldn't parse, push empty to avoid losing the layer
      out.add(mount || "");
    }
  }
  return out;
}

function auditRoutes(appInstance, { failOnMissing = false } = {}) {
  const mustHave = [
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
    "/api/screens",          // ← satisfied by: mount "/api" + any child starting with "/screens"
    "/api/pricing",
    "/api/profile",
    "/api/notifications",
    "/api/notification-prefs",
    "/api/superadmin",
    "/api/admin",
    "/api/analytics",
    "/uploads",
  ];

  // alias rules: a required prefix is OK if ANY of these checks passes
  const aliasChecks = {
    "/api/screens": (concretePaths, mounts) => {
      // If there's a top-level "/api" mount AND we see any concrete path that begins with "/screens"
      // (because screens.routes.js defines "/screens/*" inside a router mounted at "/api")
      const hasApiMount = mounts.has("/api");
      const hasScreensChildren = concretePaths.some((p) => p.startsWith("/api/screens") || p.startsWith("/screens"));
      return hasApiMount && hasScreensChildren;
    },
  };

  const concrete = getAllConcretePaths(appInstance);
  const mounts = getTopLevelMounts(appInstance);

  console.log(`🧭 Route audit: found ~${concrete.length} concrete routes, ${mounts.size} top-level mounts`);
  let missing = 0;

  for (const reqPrefix of mustHave) {
    let ok =
      concrete.some((p) => p.startsWith(reqPrefix)) ||
      mounts.has(reqPrefix);

    if (!ok && aliasChecks[reqPrefix]) {
      ok = aliasChecks[reqPrefix](concrete, mounts);
    }

    console.log(`${ok ? "✅" : "❌"} ${reqPrefix}`);
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
