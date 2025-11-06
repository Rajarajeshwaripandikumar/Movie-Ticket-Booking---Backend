// backend/src/server.js
import dotenv from "dotenv";
dotenv.config();

import http from "http";
import path from "path";
import fs from "fs";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import { v2 as cloudinary } from "cloudinary";
import { pathToFileURL } from "url";
import multer from "multer";
import streamifier from "streamifier";

// SSE helpers (start watcher + emit snapshots)
import sse from "./socket/sse.js";

// import your app if it exports one (optional)
import appRoutes from "./app.js";

/* --------------------------------- App init -------------------------------- */
let app;
if (appRoutes && typeof appRoutes.use === "function") {
  app = appRoutes; // app.js exported an express app
} else if (typeof appRoutes === "function") {
  try {
    app = appRoutes();
  } catch {
    app = express();
  }
} else {
  app = express();
}

/* -------------------------------------------------------------------------- */
/*                             CORS — PUT FIRST!                              */
/* -------------------------------------------------------------------------- */
const envOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  process.env.FRONTEND_ORIGIN || "https://movieticketbooking-rajy.netlify.app",
  "http://localhost:5173",
  ...envOrigins,
]);

// helper for checking origin & setting ACAO consistently
function setAcaOrigin(res, origin) {
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (process.env.FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
}

// Base CORS (echo origin)
app.use(
  cors({
    origin: true,
    credentials: false, // using Authorization header, not cookies
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "X-Role",
      "Origin",
    ],
    exposedHeaders: ["Content-Length", "Content-Type"],
    optionsSuccessStatus: 204,
    maxAge: 86400,
  })
);

// Global OPTIONS so preflights never miss ACAO
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  setAcaOrigin(res, origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, X-Role, Origin"
  );
  return res.sendStatus(204);
});

// Allow-list guard AFTER base cors
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (allowedOrigins.has(origin)) {
    setAcaOrigin(res, origin);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }
  console.warn(`[CORS] blocked origin ${origin}`);
  setAcaOrigin(res, null);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return res.status(403).json({ ok: false, message: `Origin not allowed: ${origin}` });
});

/* -------------------------------------------------------------------------- */
/*                               Basic middlewares                            */
/* -------------------------------------------------------------------------- */
app.set("trust proxy", true);

// Helmet (allow cross-origin images/assets)
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

/**
 * Copy ?token= into Authorization header (helps EventSource clients)
 */
function tokenQueryToHeader(req, _res, next) {
  try {
    if (!req.headers.authorization && req.query && req.query.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
  } catch {}
  next();
}
app.use(tokenQueryToHeader);

// Debug request logger
app.use((req, res, next) => {
  try {
    console.log(`[REQ] ${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl}`);
  } catch {}
  next();
});

/* -------------------------- Optional COOP / COEP --------------------------- */
if (process.env.ENABLE_COOP_COEP === "true") {
  console.log("COOP/COEP enabled (cross-origin isolation). Make sure resources are CORP-compatible.");
  app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });
} else {
  console.log("COOP/COEP disabled (default). Set ENABLE_COOP_COEP=true to enable.");
}

/* ------------------------------ Uploads dir -------------------------------- */
const UPLOADS_DIR =
  process.env.UPLOADS_DIR || (process.env.NODE_ENV === "production" ? "/tmp/uploads" : "uploads");
const uploadsPath = path.resolve(process.cwd(), UPLOADS_DIR);

try {
  if (fs.existsSync(uploadsPath)) {
    const st = fs.statSync(uploadsPath);
    if (st.isFile()) {
      const backup = `${uploadsPath}.bak-${Date.now()}`;
      fs.renameSync(uploadsPath, backup);
      console.warn(`[startup] Found file at uploads path; renamed to ${backup}`);
      fs.mkdirSync(uploadsPath, { recursive: true });
      console.log(`[startup] Created uploads directory after renaming file: ${uploadsPath}`);
    } else {
      console.log(`[startup] uploads path exists and is a directory: ${uploadsPath}`);
    }
  } else {
    fs.mkdirSync(uploadsPath, { recursive: true });
    console.log(`[startup] Created uploads directory: ${uploadsPath}`);
  }
} catch (err) {
  console.warn("[startup] Could not ensure uploads dir (may be read-only):", err?.message || err);
}

// Static uploads with CORS
app.use("/uploads", (req, res, next) => {
  setAcaOrigin(res, req.headers.origin);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

if (fs.existsSync(uploadsPath) && fs.statSync(uploadsPath).isDirectory()) {
  app.use(
    "/uploads",
    express.static(uploadsPath, {
      maxAge: "30d",
      index: false,
      dotfiles: "ignore",
    })
  );
  console.log(`🖼️  Serving static uploads from: ${uploadsPath}`);
} else {
  console.log(
    "🖼️  Uploads directory not available — /uploads will 404 (use Cloudinary preferred in production)"
  );
}

/* ------------------------- Cloudinary configuration ------------------------ */
try {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log("Cloudinary configured:", !!process.env.CLOUDINARY_CLOUD_NAME);
} catch (e) {
  console.warn("[cloudinary] config warning:", e?.message || e);
}

/* ------------------------ Cloudinary test route (optional) ----------------- */
app.post("/api/movies/test-cloud", async (_req, res) => {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ ok: false, message: "Cloudinary not configured (missing env vars)" });
    }
    const sampleUrl = "https://res.cloudinary.com/demo/image/upload/sample.jpg";
    const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
    const result = await cloudinary.uploader.upload(sampleUrl, { folder, resource_type: "image" });
    return res.json({ ok: true, message: "Cloudinary test upload succeeded", secure_url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    console.error("[/api/movies/test-cloud] upload error:", err && (err.stack || err));
    return res.status(500).json({ ok: false, message: "Cloudinary test upload failed", error: err?.message ?? String(err), http_code: err?.http_code });
  }
});

/* ----------------------------- SSE helpers -------------------------------- */
function sseCorsHeaders(req, res, next) {
  const origin = req.headers.origin;
  setAcaOrigin(res, origin);
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  }
  next();
}

app.options("/api/notifications/stream", (req, res) => {
  const origin = req.headers.origin;
  setAcaOrigin(res, origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, X-Role, Origin"
  );
  return res.sendStatus(204);
});
app.get("/api/notifications/stream", sseCorsHeaders, sse.sseHandler);

// Legacy alias
app.options("/notifications/stream", (req, res) => {
  const origin = req.headers.origin;
  setAcaOrigin(res, origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, X-Role, Origin"
  );
  return res.sendStatus(204);
});
app.get("/notifications/stream", sseCorsHeaders, sse.sseHandler);

/* ----------------------------- Notifications REST ------------------------- */
app.get("/api/notifications/mine", (req, res) => {
  const origin = req.headers.origin;
  setAcaOrigin(res, origin);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  return res.json({ ok: true, items: [], limit });
});

/* ----------------------------- /api/upload route --------------------------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "No image file provided (field name must be 'image')" });
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: process.env.CLOUDINARY_FOLDER || "uploads", resource_type: "image" },
        (err, out) => (err ? reject(err) : resolve(out))
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });
    setAcaOrigin(res, req.headers.origin);
    res.json({ ok: true, url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    console.error("[/api/upload] upload error:", err);
    res.status(err?.http_code || 500).json({ ok: false, message: "Upload failed", error: err?.message });
  }
});

/* --------------------------- Mount other routers (ESM-safe) ---------------- */
try {
  const routers = [
    "./routes/auth.js",               // ⬅️ public login/register endpoints at /api/auth/*
    "./routes/theaters.routes.js",
    "./routes/movies.routes.js",
    "./routes/upload.routes.js",
    "./routes/showtimes.routes.js",   // ✅ mount showtimes (includes admin alias)
    "./routes/superadmin.routes.js",  // ✅ mount superadmin routes
    // "./routes/notifications.routes.js",
  ];

  for (const rpath of routers) {
    try {
      const absPath = path.join(process.cwd(), rpath);
      if (!fs.existsSync(absPath)) {
        console.log(`[mount] ${rpath} not found, skipping`);
        continue;
      }

      const fileUrl = pathToFileURL(absPath).href;
      const mod = await import(fileUrl);
      const router = mod.default || mod;
      const prefix = router && router.routesPrefix ? router.routesPrefix : "/api";

      if (router && (typeof router === "function" || router?.stack)) {
        app.use(prefix, router);
        console.log(`[mount] ${rpath} mounted at ${prefix}`);

        // ✅ UK spelling alias for theaters
        if (prefix === "/api/theaters") {
          app.use("/api/theatres", router);
          console.log(`[alias] ${rpath} ALSO mounted at /api/theatres`);
        }
      } else {
        console.warn(`[mount] ${rpath} imported but did not export a router (default export missing)`);
      }
    } catch (e) {
      console.warn(`[mount] failed to mount ${rpath}:`, e?.message || e);
    }
  }
} catch (e) {
  console.warn("[mount] router auto-mount skipped:", e?.message || e);
}

/* --------------------------- Dev helper routes --------------------------- */
if ((process.env.NODE_ENV || "development") !== "production") {
  app.post("/dev/emit-snapshot", express.json(), async (req, res) => {
    try {
      const days = Number(req.body?.days || req.query?.days || 30);
      const delivered = await sse.emitAnalyticsSnapshot({ days });
      res.json({ delivered });
    } catch (err) {
      console.error("/dev/emit-snapshot error", err);
      res.status(500).json({ error: "emit_failed", message: String(err) });
    }
  });
}

/* ---------------------- Runtime environment debug info --------------------- */
console.log("🔍 Runtime env check (sensitive values hidden)");
console.log("  NODE_ENV =", process.env.NODE_ENV || "development");
console.log("  PORT     =", process.env.PORT || "8080");
console.log("  MONGO_URI present =", !!process.env.MONGO_URI || !!process.env.MONGODB_URI);
console.log("  CLOUDINARY_CLOUD_NAME present =", !!process.env.CLOUDINARY_CLOUD_NAME);
console.log("  CLOUDINARY_API_KEY present =", !!process.env.CLOUDINARY_API_KEY);
console.log("  CLOUDINARY_API_SECRET present =", !!process.env.CLOUDINARY_API_SECRET);
console.log("  CLOUDINARY_FOLDER =", process.env.CLOUDINARY_FOLDER || "(default movie-posters)");
console.log("  FRONTEND_ORIGINS =", process.env.FRONTEND_ORIGINS || "(none)");

app.get("/_health", (_req, res) => {
  setAcaOrigin(res, _req.headers.origin);
  res.json({ ok: true, uptime: process.uptime(), env: process.env.NODE_ENV || "development" });
});

/* ----------------------- Explicit login preflight (belt + suspenders) ------ */
app.options("/api/auth/login", (req, res) => {
  const origin = req.headers.origin;
  setAcaOrigin(res, origin);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, Origin"
  );
  return res.sendStatus(204);
});

/* ------------------------------- 404 & errors ------------------------------ */
app.use((req, res, next) => {
  setAcaOrigin(res, req.headers.origin);
  res.status(404).json({ ok: false, message: "Not Found" });
});

app.use((err, req, res, next) => {
  setAcaOrigin(res, req.headers.origin);
  console.error("Unhandled error:", err);
  res.status(500).json({ ok: false, message: "Server error" });
});

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

/***************************************************************
 * DEBUG HELPERS — add BEFORE start()
 ***************************************************************/
function getMountedRoutes() {
  const routes = [];
  const stack = app._router && app._router.stack ? app._router.stack : [];
  stack.forEach((middleware) => {
    if (middleware.route) {
      routes.push({ path: middleware.route.path, methods: Object.keys(middleware.route.methods) });
    } else if (middleware.name === "router" && middleware.handle && middleware.handle.stack) {
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          routes.push({ path: handler.route.path, methods: Object.keys(handler.route.methods) });
        }
      });
    }
  });
  return routes;
}

function routeExists(pathToFind) {
  const routes = getMountedRoutes();
  return routes.some((r) => r.path === pathToFind);
}

app.get("/debug/routes", (_req, res) => {
  try {
    const routes = getMountedRoutes();
    setAcaOrigin(res, _req.headers.origin);
    res.json({ ok: true, count: routes.length, routes });
  } catch (e) {
    console.error("/debug/routes error:", e);
    res.status(500).json({ ok: false, message: "Could not list routes", error: String(e) });
  }
});

/* ----------------------------- Server boot -------------------------------- */
const PORT = Number(process.env.PORT) || 8080;
let server;
let shuttingDown = false;

async function start() {
  try {
    app.locals.dbReady = false;
    server = http.createServer(app);

    // tune keep-alive and headers so SSE and long polling work reliably behind proxies
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

    // Start SSE helpers: change-stream watcher + periodic snapshot emitter
    try {
      if (sse && typeof sse.startBookingWatcher === "function") {
        sse.startBookingWatcher();
      } else {
        console.warn("SSE module missing startBookingWatcher — skipping watcher start");
      }

      const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 60_000);
      if (SNAPSHOT_INTERVAL_MS > 0) {
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⚠️ Received ${signal} — shutting down...`);
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
