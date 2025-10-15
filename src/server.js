// server.js
import http from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";
import app from "./app.js";

dotenv.config();

const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI (or MONGODB_URI) is not set. Put it in .env (do NOT hardcode credentials).");
  process.exit(1);
}

// --- simple exponential backoff connect helper ---
async function connectWithRetry(uri, maxAttempts = 5) {
  let attempt = 0;
  const baseDelay = 1000; // 1s

  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`🔌 Attempting MongoDB connection (attempt ${attempt}/${maxAttempts})...`);
      await mongoose.connect(uri);
      console.log("✅ MongoDB connected");
      return;
    } catch (err) {
      console.error(`MongoDB connect attempt ${attempt} failed:`, err?.message || err);
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(30_000, baseDelay * Math.pow(2, attempt)); // cap 30s
      console.log(`⏳ Waiting ${delay}ms before retrying...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// track server & shutdown state
let server;
let shuttingDown = false;

async function start() {
  try {
    await connectWithRetry(MONGO_URI, 6);

    // helpful runtime listeners
    mongoose.connection.on("error", (err) => console.error("MongoDB connection error:", err));
    mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
    mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected"));

    // Create explicit HTTP server so we can tune timeouts for SSE
    server = http.createServer(app);

    // ---- SSE-friendly timeouts (Node 20/22 tightened defaults) ----
    // Allow requests/headers to live indefinitely (SSE is a single long-lived request)
    server.requestTimeout = 0;           // disable 300s default
    server.headersTimeout = 0;           // disable 60s default
    // Keep connections around for a long time (unrelated to an active SSE request, but good hygiene)
    server.keepAliveTimeout = 2 * 60 * 60 * 1000; // 2 hours
    server.maxRequestsPerSocket = 0;     // unlimited

    // Ensure OS-level TCP keepalives so intermediaries don’t drop idle connections
    server.on("connection", (socket) => {
      try {
        socket.setKeepAlive(true, 30_000); // send TCP keepalive every 30s
        socket.setNoDelay(true);           // disable Nagle's algorithm for lower latency
      } catch {}
    });

    server.listen(PORT, () => {
      console.log(`🚀 API running on http://localhost:${PORT} (env=${process.env.NODE_ENV || "development"})`);
    });

    // graceful shutdown handler
    const shutdown = async (signal) => {
      if (shuttingDown) {
        console.warn("Shutdown already in progress, ignoring duplicate signal.");
        return;
      }
      shuttingDown = true;
      console.log(`\n⚠️ Received ${signal} — starting graceful shutdown...`);

      try {
        if (server) {
          // stop accepting new connections; existing SSE streams will close
          await new Promise((resolve) => server.close(resolve));
          console.log("HTTP server closed.");
        }

        // give in-flight requests up to N ms to finish (optional)
        const GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
        console.log(`Waiting up to ${GRACE_PERIOD_MS}ms for in-flight requests to finish...`);
        await new Promise((res) => setTimeout(res, GRACE_PERIOD_MS));

        await mongoose.disconnect();
        console.log("✅ MongoDB disconnected, exiting.");
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
    console.error("❌ Failed to start app (MongoDB connection error):", err);
    process.exit(1);
  }
}

start();
