import http from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import express from "express"; // ✅ Needed for static file serving
import app from "./app.js";

dotenv.config();

/* -------------------------------------------------------------------------- */
/*                          STATIC FILES: /uploads                            */
/* -------------------------------------------------------------------------- */
// Serve the local uploads folder (for legacy movie posters)
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
    maxAge: "30d", // cache for performance
    index: false,
    dotfiles: "ignore",
  })
);
console.log(`🖼️  Serving static uploads from: ${uploadsPath}`);

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
/**
 * Exponential backoff with capped delay; tighter client-side timeouts
 * so cold/blocked DB doesn't stall boot.
 */
async function connectWithRetry(uri, maxAttempts = 6) {
  let attempt = 0;
  const baseDelay = 1000; // 1s

  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(
        `🔌 Attempting MongoDB connection (attempt ${attempt}/${maxAttempts})...`
      );
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10_000, // fail fast
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 30_000,
        // dbName: process.env.MONGO_DB,
      });
      console.log("✅ MongoDB connected");
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`MongoDB connect attempt ${attempt} failed: ${msg}`);
      if (attempt >= maxAttempts) throw err;

      const delay = Math.min(30_000, baseDelay * 2 ** attempt); // cap at 30s
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
    // Flag for readiness checks
    app.locals.dbReady = false;

    // Explicit HTTP server (SSE / socket friendly)
    server = http.createServer(app);

    // SSE / keep-alive friendly server settings
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 2 * 60 * 60 * 1000; // 2h
    server.maxRequestsPerSocket = 0;

    // Keep-alive TCP
    server.on("connection", (socket) => {
      try {
        socket.setKeepAlive(true, 30_000);
        socket.setNoDelay(true);
      } catch {
        /* ignore */
      }
    });

    // Start listening immediately
    server.listen(PORT, () => {
      console.log(
        `🚀 API running on http://localhost:${PORT} (env=${
          process.env.NODE_ENV || "development"
        })`
      );
    });

    // MongoDB connection events
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

    // Connect DB in background
    connectWithRetry(MONGO_URI, 6)
      .then(() => {
        app.locals.dbReady = true;
        console.log("✅ MongoDB ready");
      })
      .catch((err) => {
        console.error("❌ MongoDB failed after retries:", err);
      });

    // Graceful shutdown
    const shutdown = async (signal) => {
      if (shuttingDown) {
        console.warn(
          "Shutdown already in progress; ignoring duplicate signal."
        );
        return;
      }
      shuttingDown = true;
      console.log(`\n⚠️ Received ${signal} — starting graceful shutdown...`);

      try {
        // Stop accepting new connections
        if (server) {
          await new Promise((resolve) => server.close(resolve));
          console.log("HTTP server closed.");
        }

        // Allow inflight requests
        const GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
        console.log(
          `Waiting up to ${GRACE_PERIOD_MS}ms for in-flight requests to finish...`
        );
        await new Promise((res) => setTimeout(res, GRACE_PERIOD_MS));

        // Disconnect DB
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
