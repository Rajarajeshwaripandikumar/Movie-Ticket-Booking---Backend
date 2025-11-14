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

// heartbeat (10 seconds)
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 10000);

// Keep open browser tabs limited per user
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

// Global client store
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
  const h = req.headers.authorization || "";
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

/* ------------------------------- FIXED ROLE ------------------------------- */
/**
 * FIXED:
 *   - SUPER_ADMIN → "SUPER_ADMIN"
 *   - ADMIN → "ADMIN"
 *   - THEATRE_ADMIN → "THEATRE_ADMIN"
 *   - THEATER_ADMIN → "THEATRE_ADMIN"
 *   - User → "USER"
 */
function roleFrom(decoded) {
  const raw = String(
    decoded?.role ||
    decoded?.roles?.[0] ||
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
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.sendStatus(204);
};

/* -------------------------------- HANDLER -------------------------------- */
export const sseHandler = async (req, res) => {
  try {
    req.socket?.setKeepAlive?.(true);
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);

    // CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    // Auth
    const rawToken = extractToken(req);
    if (!rawToken || !rawToken.includes(".")) return res.status(401).end("Unauthorized");

    const decoded = JWT_PUBLIC_KEY
      ? jwt.verify(rawToken, JWT_PUBLIC_KEY, { algorithms: ["RS256"] })
      : jwt.verify(rawToken, JWT_SECRET, { algorithms: ["HS256"] });

    const userId = decoded.sub || decoded.id || decoded.userId || decoded.user?.id;
    if (!userId) return res.status(401).end("Unauthorized");

    const role = roleFrom(decoded);

    /* -------------------------------- CHANNEL FIX ------------------------------- */
    /**
     * Old logic → EVERYTHING became "admin"
     * NEW logic → Fully isolated channels:
     *   SUPER_ADMIN → "super_admin"
     *   ADMIN → "admin"
     *   THEATRE_ADMIN → "theatre_admin_<userId>"
     *   USER → "<userId>"
     */
    let channel;

    if (role === "SUPER_ADMIN") channel = "super_admin";
    else if (role === "ADMIN") channel = "admin";
    else if (role === "THEATRE_ADMIN") channel = `theatre_admin_${userId}`;
    else channel = String(userId);

    /* --------------------------------------------------------------------------- */

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Accel-Buffering", "no");

    sseWriteRaw(res, "retry: 10000\n");
    sseWriteRaw(res, `: hello ${Date.now()}\n\n`);
    res.flushHeaders?.();

    // Register client
    const set = global.sseClients.get(channel) || new Set();
    if (set.size >= MAX_CLIENTS_PER_USER) return res.end();
    set.add(res);
    global.sseClients.set(channel, set);

    // Connected event
    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    // Initial notifications snapshot
    try {
      const Notification = mongoose.model("Notification");
      const initial = await Notification.find({})
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      sseWrite(res, { event: "init", data: { notifications: initial } });
    } catch {
      sseWrite(res, { event: "init", data: { notifications: [] } });
    }

    // Heartbeat
    const ping = setInterval(() => {
      sseWriteRaw(res, `: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(ping);
      const set = global.sseClients.get(channel);
      if (set) set.delete(res);
      if (!set || set.size === 0) global.sseClients.delete(channel);
    };

    req.on("close", cleanup);
    res.on("error", cleanup);
  } catch (err) {
    debug("sseHandler error:", err);
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
  return total;
};

/** SEND ONLY TO A SPECIFIC USER */
export const pushToUser = (userId, payload, { eventName = "notification" } = {}) => {
  const set = global.sseClients.get(String(userId)) || new Set();
  let total = 0;

  for (const res of set) {
    sseWrite(res, { event: eventName, data: payload });
    total++;
  }
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

export function startBookingWatcher() {
  debug("startBookingWatcher: stub");
}

export default {
  sseHandler,
  ssePreflight,
  pushToUser,
  pushToAdmins,
  emitAnalyticsSnapshot,
  startBookingWatcher,
};
