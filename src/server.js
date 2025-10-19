// backend/src/server.js
import dotenv from "dotenv";
// load .env right away so imports below see env vars
dotenv.config();

import http from "http";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import express from "express"; // needed for static serving
import { v2 as cloudinary } from "cloudinary";
import app from "./app.js";

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

// Ensure folder exists
try {
  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
    console.log(`📁 Created uploads directory at: ${uploadsPath}`);
  }
} catch (err) {
  console.warn("[startup] Could not ensure uploads dir:", err?.message || err);
}

// Mount static /uploads route before anything else
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
/*                         Cloudinary SDK config (for test route)             */
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
/*                         Temporary debug route: test Cloudinary             */
/* -------------------------------------------------------------------------- */
/**
 * POST /api/movies/test-cloud
 * No auth. uploads a public sample image to your Cloudinary account and returns result.
 * Remove this route after debugging.
 */
app.post("/api/movies/test-cloud", async (_req, res) => {
  try {
    // sample remote image url (Cloudinary demo)
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
/*                             ENV + DB CONFIG                                */
/* -------------------------------------------------------------------------- */
const PORT = Number(process.env.PORT) || 8080;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error(
    "❌ MONGO_URI (or MONGODB_URI) is not set. Put it in .env (do NOT hardcode credentials)."
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*                           MongoDB Connect Helper                           */
/* -------------------------------------------------------------------------- */
async function connectWithRetry(uri, maxAttempts = 6) {
  let attempt = 0;
  const baseDelay = 1000;
  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(
        `🔌 Attempting MongoDB connection (attempt ${attempt}/${maxAttempts})...`
      );
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
      console.log(`⏳ Waiting ${delay}ms before retrying...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             HTTP Server Boot                               */
/* -------------------------------------------------------------------------- */
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
      console.log(
        `🚀 API running on http://localhost:${PORT} (env=${
          process.env.NODE_ENV || "development"
        })`
      );
    });

    mongoose.connection.on("error", (err) =>
      console.error("MongoDB connection error:", err)
    );
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
        console.error("❌ MongoDB failed after retries:", err);
      });

    const shutdown = async (signal) => {
      if (shuttingDown) {
        console.warn("Shutdown already in progress; ignoring duplicate signal.");
        return;
      }
      shuttingDown = true;
      console.log(`\n⚠️ Received ${signal} — starting graceful shutdown...`);

      try {
        if (server) {
          await new Promise((resolve) => server.close(resolve));
          console.log("HTTP server closed.");
        }

        const GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
        console.log(
          `Waiting up to ${GRACE_PERIOD_MS}ms for in-flight requests to finish...`
        );
        await new Promise((res) => setTimeout(res, GRACE_PERIOD_MS));

        await mongoose.disconnect();
        console.log("✅ MongoDB disconnected. Bye!");
        process.exit(0);
      } catch (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("unhandledRejection", (reason) => {
      console.error("Unhandled Rejection:", reason);
      shutdown("unhandledRejection").catch(() => process.exit(1));
    });
    process.on("uncaughtException", (err) => {
      console.error("Uncaught Exception:", err);
      shutdown("uncaughtException").catch(() => process.exit(1));
    });
  } catch (err) {
    console.error("❌ Failed to start app:", err);
    process.exit(1);
  }
}

start();
