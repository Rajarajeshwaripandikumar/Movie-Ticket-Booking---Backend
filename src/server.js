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

/* ----------------------------- CORS config -------------------------------- */
const envOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  process.env.FRONTEND_ORIGIN || "https://movieticketbooking-rajy.netlify.app",
  "http://localhost:5173",
  ...envOrigins,
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (allowedOrigins.includes(origin)) return next();

  console.warn(`[CORS] blocked origin ${origin}`);
  res.setHeader("Access-Control-Allow-Origin", "null");
  return res.status(403).json({ ok: false, message: "CORS: origin not allowed" });
});

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    exposedHeaders: ["Content-Length", "Content-Type"],
    optionsSuccessStatus: 204,
  })
);

// Ensure preflight works
app.options("*", cors());

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
// prefer /tmp/uploads in production; local 'uploads' for dev
const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.NODE_ENV === "production" ? "/tmp/uploads" : "uploads");
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
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "https://movieticketbooking-rajy.netlify.app");
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
    const sampleUrl = "https://res.cloudinary.com/demo/image/upload/sample.jpg";
    const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
    const result = await cloudinary.uploader.upload(sampleUrl, {
      folder,
      resource_type: "image",
    });
    return res.json({
      ok: true,
      message: "Cloudinary test upload succeeded",
      secure_url: result.secure_url,
      public_id: result.public_id,
      raw: result,
    });
  } catch (err) {
    console.error("[test-cloud] error:", err);
    return res.status(500).json({
      ok: false,
      message: "Cloudinary test upload failed",
      error: err?.message,
      http_code: err?.http_code,
      http_body: err?.http_body,
    });
  }
});

/* ----------------------------- /api/upload route --------------------------- */
// Streams uploaded file to Cloudinary; expects field name "image"
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

    res.json({ ok: true, url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    console.error("[/api/upload] upload error:", err);
    res.status(500).json({ ok: false, message: "Upload failed", error: err?.message });
  }
});

/* --------------------------- Mount other routers --------------------------- */
/*
  If your app.js already mounted routes you can skip mounting here.
  Otherwise import and mount them like:

  import theatersRouter from "./routes/theaters.routes.js";
  import moviesRouter from "./routes/movies.routes.js";
  app.use("/api/theaters", theatersRouter);
  app.use("/api/movies", moviesRouter);
*/

// If app.js exported an app with routes already, they will be used.

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

/* ----------------------------- Server boot -------------------------------- */
const PORT = Number(process.env.PORT) || 8080;
let server;
let shuttingDown = false;

async function start() {
  try {
    app.locals.dbReady = false;
    server = http.createServer(app);

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
