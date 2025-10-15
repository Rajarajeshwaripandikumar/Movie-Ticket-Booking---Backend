// server.js
import http from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";
import app from "./app.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 8080;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI (or MONGODB_URI) is not set. Put it in .env (do NOT hardcode credentials).");
  process.exit(1);
}

/* --------------------------- MongoDB connect helper --------------------------- */
/** Exponential backoff with capped delay; tighter client-side timeouts so cold/blocked DB doesn't stall boot */
async function connectWithRetry(uri, maxAttempts = 6) {
  let attempt = 0;
  const baseDelay = 1000; // 1s

  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`🔌 Attempting MongoDB connection (attempt ${attempt}/${maxAttempts})...`);
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10_000, // fail fast if cluster not reachable
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 30_000,
        // dbName: process.env.MONGO_DB, // uncomment if you need a specific db
      });
      console.log("✅ MongoDB connected");
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`MongoDB connect attempt ${attempt} failed: ${msg}`);
      if (attempt >= maxAttempts) throw err;

      const delay = Math.min(30_000, baseDelay * 2 ** attempt); // cap 30s
      console.log(`⏳ Waiting ${delay}ms before retrying...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/* ------------------------------ HTTP server boot ----------------------------- */
let server;
let shuttingDown = false;

async function start() {
  try {
    // Expose readiness for /health and route guards in app.js
    app.locals.dbReady = false;

    // Create explicit HTTP server (lets us tune timeouts for SSE / long polling)
    server = http.createServer(app);

    // SSE-friendly: disable strict defaults introduced in newer Node versions
    server.requestTimeout = 0;                // no 300s cap on active requests
    server.headersTimeout = 0;                // no 60s cap waiting for headers
    server.keepAliveTimeout = 2 * 60 * 60 * 1000; // 2h keep-alive
    server.maxRequestsPerSocket = 0;          // unlimited

    // TCP keepalives so intermediaries don’t drop idle sockets
    server.on("connection", (socket) => {
      try {
        socket.setKeepAlive(true, 30_000); // 30s TCP keepalive probe
        socket.setNoDelay(true);           // lower latency
      } catch {
        /* ignore */
      }
    });

    // Start listening immediately so health/CORS/preflight respond fast even if DB is cold
    server.listen(PORT, () => {
      console.log(`🚀 API running on http://localhost:${PORT} (env=${process.env.NODE_ENV || "development"})`);
    });

    // Attach Mongo connection event listeners (after server is up)
    mongoose.connection.on("error", (err) => console.error("MongoDB connection error:", err));
    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB disconnected");
      app.locals.dbReady = false;
    });
    mongoose.connection.on("reconnected", () => {
      console.log("MongoDB reconnected");
      app.locals.dbReady = true;
    });

    // Connect DB in the background (don’t block HTTP)
    connectWithRetry(MONGO_URI, 6)
      .then(() => {
        app.locals.dbReady = true;
        console.log("✅ MongoDB ready");
      })
      .catch((err) => {
        console.error("❌ MongoDB failed after retries:", err);
        // You can choose to exit here if DB is mandatory:
        // process.exit(1);
      });

    // Graceful shutdown wiring
    const shutdown = async (signal) => {
      if (shuttingDown) {
        console.warn("Shutdown already in progress; ignoring duplicate signal.");
        return;
      }
      shuttingDown = true;
      console.log(`\n⚠️ Received ${signal} — starting graceful shutdown...`);

      try {
        // Stop accepting new connections; existing ones (incl. SSE) will close
        if (server) {
          await new Promise((resolve) => server.close(resolve));
          console.log("HTTP server closed.");
        }

        // Allow in-flight handlers to finish
        const GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
        console.log(`Waiting up to ${GRACE_PERIOD_MS}ms for in-flight requests to finish...`);
        await new Promise((res) => setTimeout(res, GRACE_PERIOD_MS));

        // Close DB
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
