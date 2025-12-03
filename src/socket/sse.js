// backend/src/socket/sse.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import debugFactory from "debug";

const debug = debugFactory("app:sse");

/* ------------------------------- CONFIG ---------------------------------- */
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_BASE64 ||
  "dev_jwt_secret_change_me";

const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || null;

// heartbeat (ms)
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 10000);

// Keep open browser tabs limited per user
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

// Global client store shared across the server
global.sseClients = global.sseClients || new Map();

/* ------------------------------ UTILITIES -------------------------------- */
function sseWriteRaw(res, str) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(str);
    return true;
  } catch {
    return false;
  }
}

function sseWrite(res, { event, id, data }) {
  if (!res || res.writableEnded || res.destroyed) return false;
  if (event) sseWriteRaw(res, `event: ${event}\n`);
  if (id) sseWriteRaw(res, `id: ${id}\n`);
  sseWriteRaw(res, `data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function extractToken(req) {
  const h = (req.headers.authorization || "").toString();
  const cookies = parseCookie(req.headers.cookie || "");
  return (
    (h.startsWith("Bearer ") && h.slice(7)) ||
    req.query?.token ||
    cookies.token ||
    cookies.access_token ||
    cookies.jwt ||
    null
  );
}

/* ------------------------------- ROLE HELPERS ---------------------------- */
/**
 * Normalizes basic roles from token claims into canonical values used by the SSE channels.
 */
function roleFrom(decoded) {
  const raw = String(
    decoded?.role ||
    (decoded?.roles && decoded.roles[0]) ||
    (decoded?.isAdmin ? "ADMIN" : "USER") ||
    "USER"
  ).trim().toUpperCase();

  if (raw.includes("SUPER")) return "SUPER_ADMIN";
  if (raw.includes("THEATRE") || raw.includes("THEATER")) return "THEATRE_ADMIN";
  if (raw === "ADMIN" || raw.includes("ADMIN")) return "ADMIN";
  return "USER";
}

/* ------------------------------ CORS PREFLIGHT --------------------------- */
export const ssePreflight = (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Last-Event-ID, X-Role, Origin"
  );
  // For SSE we typically don't expose credentials; follow your app's policy.
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.sendStatus(204);
};

/* -------------------------------- HANDLER -------------------------------- */
export const sseHandler = async (req, res) => {
  try {
    // keep socket open
    req.socket?.setKeepAlive?.(true);
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);

    // CORS reflect
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    // Auth - extract token from header / query / cookies
    const rawToken = extractToken(req);
    if (!rawToken || !rawToken.includes(".")) return res.status(401).end("Unauthorized");

    let decoded;
    try {
      decoded = JWT_PUBLIC_KEY
        ? jwt.verify(rawToken, JWT_PUBLIC_KEY, { algorithms: ["RS256"] })
        : jwt.verify(rawToken, JWT_SECRET, { algorithms: ["HS256"] });
    } catch (err) {
      debug("token verify failed:", err && (err.message || err));
      return res.status(401).end("Unauthorized");
    }

    const userId = (decoded.sub || decoded.id || decoded.userId || decoded.user?.id || "");
    if (!userId) return res.status(401).end("Unauthorized");

    const role = roleFrom(decoded);

    // Determine channel naming convention
    // SUPER_ADMIN -> "super_admin"
    // ADMIN -> "admin"
    // THEATRE_ADMIN -> "theatre_admin_<userId>"
    // USER -> "<userId>"
    let channel;
    if (role === "SUPER_ADMIN") channel = "super_admin";
    else if (role === "ADMIN") channel = "admin";
    else if (role === "THEATRE_ADMIN") channel = `theatre_admin_${String(userId)}`;
    else channel = String(userId);

    /* ---------------- SSE response headers ---------------- */
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Accel-Buffering", "no");

    // quick retry hint
    sseWriteRaw(res, "retry: 10000\n");
    sseWriteRaw(res, `: hello ${Date.now()}\n\n`);
    res.flushHeaders?.();

    /* ---------------- register client ---------------- */
    const set = global.sseClients.get(channel) || new Set();
    if (set.size >= MAX_CLIENTS_PER_USER) {
      debug(`max clients reached for ${channel} (${set.size}) — rejecting`);
      return res.end();
    }
    set.add(res);
    global.sseClients.set(channel, set);

    // attach writable check
    res._sseWritable = () => !res.writableEnded && !res.destroyed;

    debug(`[SSE] CONNECT channel=${channel} listeners=${set.size}`);

    // Send connected event
    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    /* -------------- optional: seed initial notifications -------------- */
    // If client asked for seed=1, return recent notifications that they can see
    if (String(req.query.seed || "") === "1") {
      try {
        const Notification = mongoose.model("Notification");
        const limit = Math.min(Number(req.query.limit) || 20, 100);

        // Build visibility query analogous to notifications.routes.visibilityOr
        let q;
        if (role === "ADMIN" || role === "SUPER_ADMIN") {
          q = { $or: [{ audience: "ADMIN" }, { audience: "ALL" }] };
        } else {
          // user-scoped + USER audience + ALL
          q = {
            $or: [
              { user: String(userId) },
              { audience: { $in: [null, "USER"] } },
              { audience: "ALL" },
            ],
          };
        }

        const initial = await Notification.find(q).sort({ createdAt: -1 }).limit(limit).lean();
        sseWrite(res, { event: "init", data: { notifications: initial } });
      } catch (err) {
        debug("seed fetch error:", err && (err.message || err));
        sseWrite(res, { event: "init", data: { notifications: [] } });
      }
    }

    /* ---------------- heartbeat ---------------- */
    const ping = setInterval(() => {
      if (!res._sseWritable || !res._sseWritable()) return;
      sseWriteRaw(res, `: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    /* ---------------- cleanup on close/error ---------------- */
    const cleanup = () => {
      clearInterval(ping);
      try {
        const s = global.sseClients.get(channel);
        if (s) {
          s.delete(res);
          if (s.size === 0) global.sseClients.delete(channel);
        }
      } catch (e) {
        debug("cleanup error:", e);
      }
      debug(`[SSE] CLOSE channel=${channel}`);
    };

    req.on("close", cleanup);
    res.on("error", cleanup);
  } catch (err) {
    debug("sseHandler error:", err && (err.message || err));
    if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
  }
};

/* ----------------------------- PUSH FUNCTIONS ----------------------------- */

/** SEND TO ALL ADMINS (SUPER + ADMIN only) */
export const pushToAdmins = (payload, { eventName = "notification" } = {}) => {
  let total = 0;
  const channels = ["admin", "super_admin"];
  for (const ch of channels) {
    const set = global.sseClients.get(ch) || new Set();
    for (const res of set) {
      sseWrite(res, { event: eventName, data: payload });
      total++;
    }
  }
  debug(`[SSE] pushToAdmins delivered=${total}`);
  return total;
};

/** SEND ONLY TO A SPECIFIC USER */
export const pushToUser = (userId, payload, { eventName = "notification" } = {}) => {
  const key = String(userId);
  const set = global.sseClients.get(key) || new Set();
  let total = 0;
  for (const res of set) {
    sseWrite(res, { event: eventName, data: payload });
    total++;
  }
  debug(`[SSE] pushToUser user=${key} delivered=${total}`);
  return total;
};

/** SEND TO A THEATRE_ADMIN CHANNEL (if used) */
export const pushToTheatreAdmin = (userId, payload, { eventName = "notification" } = {}) => {
  const key = `theatre_admin_${String(userId)}`;
  const set = global.sseClients.get(key) || new Set();
  let total = 0;
  for (const res of set) {
    sseWrite(res, { event: eventName, data: payload });
    total++;
  }
  debug(`[SSE] pushToTheatreAdmin theatreAdmin=${key} delivered=${total}`);
  return total;
};

/** OPTIONAL: Analytics snapshot (goes only to admins) */
export async function emitAnalyticsSnapshot(options = {}) {
  try {
    const { days = 30 } = options;
    const payload = {
      type: "analytics_snapshot",
      days,
      ts: Date.now(),
    };
    return pushToAdmins(payload, { eventName: "analytics" });
  } catch (e) {
    debug("emitAnalyticsSnapshot error:", e?.message || e);
    return 0;
  }
}

/* -------------------------- Booking watcher stub ------------------------- */
export function startBookingWatcher() {
  debug("startBookingWatcher: not implemented in sse.js (optional)");
}

export default {
  sseHandler,
  ssePreflight,
  pushToUser,
  pushToAdmins,
  pushToTheatreAdmin,
  emitAnalyticsSnapshot,
  startBookingWatcher,
};
