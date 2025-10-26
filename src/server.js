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

// import your app if it exports one (optional)
import appRoutes from "./app.js";

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

// basic middlewares
app.set("trust proxy", true);
app.use(helmet());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

/**
 * Server-level middleware: copy ?token= query param into Authorization header.
 * This must run early (before any auth middleware or routers that enforce auth),
 * so EventSource clients that cannot set headers can still authenticate.
 *
 * Security note: tokens in querystrings can be leaked via logs/referrers.
 * Use short-lived tokens for SSE / ensure you do not log the full value.
 */
function tokenQueryToHeader(req, _res, next) {
  try {
    if (!req.headers.authorization && req.query && req.query.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
      // optional debug while rolling out (comment out in production)
      // console.debug('[auth] set Authorization header from ?token for', req.originalUrl);
    }
  } catch (err) {
    // ignore defensively
  }
  next();
}
// Apply it very early
app.use(tokenQueryToHeader);

// ---------- TEMP DEBUG: simple request logger (remove in production) ----------
app.use((req, res, next) => {
  // do not log full token (sensitive) — only show path + method + timestamp
  try {
    console.log(`[REQ] ${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl}`);
  } catch (e) {}
  next();
});
// ---------------------------------------------------------------------------

/* ----------------------------- CORS config -------------------------------- */
const envOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  process.env.FRONTEND_ORIGIN || "https://movieticketbooking-rajy.netlify.app",
  "http://localhost:5173",
  ...envOrigins,
]);

// Centralized CORS options
const corsOptions = {
  origin: (origin, cb) => {
    // allow non-browser requests with no origin (curl, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    console.warn(`[CORS] blocked origin ${origin}`);
    return cb(new Error("Origin not allowed by CORS"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  exposedHeaders: ["Content-Length", "Content-Type"],
  optionsSuccessStatus: 204,
};

// Use cors middleware early so it always runs before routes
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

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

// Add header so static uploaded files can be embedded cross-origin
app.use("/uploads", (req, res, next) => {
  // use request origin if allowed, otherwise fallback to FRONTEND_ORIGIN
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (process.env.FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
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
  console.log("🖼️  Uploads directory not available — /uploads will 404 (use Cloudinary preferred in production)");
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

/* ----------------------------- SSE / EventSource --------------------------- */
/*
  Consolidated SSE handler reused for both /api/notifications/stream and /notifications/stream
  Supports token via ?token= (copied to Authorization header by tokenQueryToHeader) or Authorization header.
*/
function setSseCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (process.env.FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function sseStreamHandler(req, res) {
  try {
    // Set CORS & SSE headers
    setSseCorsHeaders(req, res);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // Accept token from ?token= or Authorization header (tokenQueryToHeader already copies ?token into Authorization)
    const token = req.query.token || (req.headers.authorization ? req.headers.authorization.split(" ")[1] : undefined);

    // temporary log for debugging
    console.log("[SSE HIT]", { path: req.originalUrl, hasAuthHeader: Boolean(req.headers.authorization), tokenPresent: Boolean(token) });

    // initial comment to establish connection
    try { res.write(": connected\n\n"); } catch (err) {}

    // heartbeat (keep connection alive through proxies)
    const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);
    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (e) {}
    }, HEARTBEAT_MS);

    // example periodic sample data (replace with real notification push logic)
    const sampleTicker = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        const data = { msg: "heartbeat", at: new Date().toISOString() };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {}
    }, 60000);

    // cleanup on close/error
    const cleanup = () => {
      try { clearInterval(keepAlive); } catch {}
      try { clearInterval(sampleTicker); } catch {}
      try { res.end(); } catch {}
    };

    req.on("close", cleanup);
    req.on("end", cleanup);
    res.on("error", (err) => {
      console.log("[SSE socket error]", err && err.message);
      cleanup();
    });

    // keep the response open
    return;
  } catch (err) {
    console.error("[sseStreamHandler] error:", err && err.stack ? err.stack : err);
    try {
      if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
    } catch {}
  }
}

// Register OPTIONS + GET for both /api/notifications/stream and /notifications/stream
app.options("/api/notifications/stream", (req, res) => {
  setSseCorsHeaders(req, res);
  return res.sendStatus(204);
});
app.get("/api/notifications/stream", sseStreamHandler);

app.options("/notifications/stream", (req, res) => {
  setSseCorsHeaders(req, res);
  return res.sendStatus(204);
});
app.get("/notifications/stream", sseStreamHandler);

/* ----------------------------- /api/upload route --------------------------- */
import multer from "multer";
import streamifier from "streamifier";
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

    // ensure CORS header set for the response
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    res.json({ ok: true, url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    console.error("[/api/upload] upload error:", err);
    res.status(err?.http_code || 500).json({ ok: false, message: "Upload failed", error: err?.message });
  }
});

/* --------------------------- Mount other routers --------------------------- */
try {
  // dynamic mount if file exists
  const routers = ["./routes/theaters.routes.js", "./routes/movies.routes.js", "./routes/upload.routes.js"];
  routers.forEach((rpath) => {
    try {
      if (fs.existsSync(path.join(process.cwd(), rpath))) {
        // import dynamically so missing files don't crash startup
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(rpath);
        const router = mod.default || mod;
        app.use(router.routesPrefix || "/api", router); // router may export routesPrefix
        console.log(`[mount] ${rpath} mounted`);
      }
    } catch (e) {
      console.warn(`[mount] failed to mount ${rpath}:`, e?.message || e);
    }
  });
} catch (e) {
  console.warn("[mount] router auto-mount skipped:", e?.message || e);
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
  res.json({ ok: true, uptime: process.uptime(), env: process.env.NODE_ENV || "development" });
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
      // direct route
      routes.push({ path: middleware.route.path, methods: Object.keys(middleware.route.methods) });
    } else if (middleware.name === "router" && middleware.handle && middleware.handle.stack) {
      // router with nested routes
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          routes.push({ path: handler.route.path, methods: Object.keys(handler.route.methods) });
        }
      });
    }
  });
  return routes;
}

function routeExists(path) {
  const routes = getMountedRoutes();
  return routes.some((r) => r.path === path);
}

// Expose mounted routes for quick verification
app.get("/debug/routes", (_req, res) => {
  try {
    const routes = getMountedRoutes();
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
      console.log(`🚀 API listening on http://localhost:${PORT} (port ${PORT})`);
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
