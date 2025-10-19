// backend/src/server.js
import dotenv from "dotenv";
dotenv.config();

import http from "http";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";
import app from "./app.js";

/* -------------------------------------------------------------------------- */
/*                             ✅ CORS FIX START                              */
/* -------------------------------------------------------------------------- */

// ✅ Define allowed frontend origins
const allowedOrigins = [
  "https://movieticketbooking-rajy.netlify.app",
  "http://localhost:5173", // dev
];

// ⚙️ Add before routes/static
app.use(
  cors({
    origin(origin, callback) {
      // allow mobile apps or curl (no origin)
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      console.warn("[CORS] Blocked origin:", origin);
      return callback(new Error("CORS not allowed for origin: " + origin));
    },
    credentials: true,
    exposedHeaders: ["Content-Length", "Content-Type"],
  })
);

// Optional headers for SSE + security
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

/* -------------------------------------------------------------------------- */
/*                      Quick runtime env checks (debug)                      */
/* -------------------------------------------------------------------------- */
console.log("🔍 Runtime env check (sensitive values hidden)");
console.log("  NODE_ENV =", process.env.NODE_ENV || "development");
console.log("  PORT     =", process.env.PORT || "8080");
console.log("  MONGO_URI present =", !!process.env.MONGO_URI || !!process.env.MONGODB_URI);
console.log("  CLOUDINARY_CLOUD_NAME =", process.env.CLOUDINARY_CLOUD_NAME || "(missing)");
console.log("  CLOUDINARY_API_KEY present =", !!process.env.CLOUDINARY_API_KEY);
console.log("  CLOUDINARY_API_SECRET present =", !!process.env.CLOUDINARY_API_SECRET);
console.log("  CLOUDINARY_FOLDER =", process.env.CLOUDINARY_FOLDER || "(default movie-posters)");

/* -------------------------------------------------------------------------- */
/*                          STATIC FILES: /uploads                            */
/* -------------------------------------------------------------------------- */
const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";
const uploadsPath = path.join(process.cwd(), UPLOADS_DIR);

try {
  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
    console.log(`📁 Created uploads directory at: ${uploadsPath}`);
  }
} catch (err) {
  console.warn("[startup] Could not ensure uploads dir:", err?.message || err);
}

// Serve uploaded files
app.use(
  "/uploads",
  express.static(uploadsPath, {
    maxAge: "30d",
    index: false,
    dotfiles: "ignore",
  })
);
console.log(`🖼️  Serving static uploads from: ${uploadsPath}`);

/* -------------------------------------------------------------------------- */
/*                         Cloudinary SDK config                              */
/* -------------------------------------------------------------------------- */
try {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} catch (e) {
  console.warn("[cloudinary] config warning:", e?.message || e);
}

/* -------------------------------------------------------------------------- */
/*                      Temporary Cloudinary test route                       */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*                             DB CONFIG + SERVER                             */
/* -------------------------------------------------------------------------- */
const PORT = Number(process.env.PORT) || 8080;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI in .env");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*                         MongoDB Connect Helper                             */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*                           HTTP Server Boot                                 */
/* -------------------------------------------------------------------------- */
let server;
let shuttingDown = false;

async function start() {
  try {
    app.locals.dbReady = false;
    server = http.createServer(app);

    // Keep-alive config
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

    server.listen(PORT, () =>
      console.log(`🚀 API running on http://localhost:${PORT}`)
    );

    mongoose.connection.on("error", (err) => console.error("MongoDB error:", err));
    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB disconnected");
      app.locals.dbReady = false;
    });
    mongoose.connection.on("reconnected", () => {
      console.log("MongoDB reconnected");
      app.locals.dbReady = true;
    });

    connectWithRetry(MONGO_URI, 6)
      .then(() => {
        app.locals.dbReady = true;
        console.log("✅ MongoDB ready");
      })
      .catch((err) => {
        console.error("❌ MongoDB failed:", err);
      });

    // graceful shutdown
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`⚠️ Received ${signal} — shutting down...`);
      try {
        if (server) await new Promise((resolve) => server.close(resolve));
        await mongoose.disconnect();
        console.log("✅ Shutdown complete");
        process.exit(0);
      } catch (err) {
        console.error("Shutdown error:", err);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("❌ Failed to start app:", err);
    process.exit(1);
  }
}

start();
