// backend/src/socket/sse.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:sse");

/* ----------------------------- config ------------------------------ */
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_SECRET_BASE64 || "dev_jwt_secret_change_me";
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || null;

const APP_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  process.env.APP_ORIGIN ||
  "https://movieticketbooking-rajy.netlify.app"; // ✅ explicit allowed frontend origin in prod

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

/* -------------------------- helpers --------------------------- */
function sseWriteRaw(res, str) {
  try {
    if (!res || res.writableEnded || res.destroyed) return false;
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
  try {
    sseWriteRaw(res, `data: ${JSON.stringify(data)}\n\n`);
  } catch {
    sseWriteRaw(res, `data: ${JSON.stringify({ error: "stringify_failed" })}\n\n`);
  }
  return true;
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function extractToken(req) {
  const authHeader = req.headers.authorization || "";
  const cookies = parseCookie(req.headers.cookie || "");
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token && req.query?.token) token = req.query.token;
  if (!token && cookies.token) token = cookies.token;
  if (!token && cookies.access_token) token = cookies.access_token;
  if (!token && cookies.jwt) token = cookies.jwt;
  return token ? String(token).trim() : null;
}

function sanitizeToken(raw) {
  if (!raw) return null;
  try { raw = decodeURIComponent(raw); } catch {}
  if ((raw.match(/\./g) || []).length !== 2) return null;
  return raw;
}

function roleFromDecoded(decoded) {
  const r = decoded?.role || decoded?.roleName || decoded?.roles?.[0] || "USER";
  return String(r).toUpperCase().includes("ADMIN") ? "ADMIN" : "USER";
}

/* ----------------------- in-process client store ------------------- */
global.sseClients = global.sseClients || new Map();

/* -------------------------- CORS preflight ------------------------- */
export const ssePreflight = (req, res) => {
  const origin = APP_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
};

/* ------------------------------ SSE handler ------------------------ */
export const sseHandler = async (req, res) => {
  try {
    // ✅ set CORS headers **BEFORE anything else** so even errors return ACAO:
    const origin = APP_ORIGIN;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");

    const rawToken = extractToken(req);
    const token = sanitizeToken(rawToken);

    if (!token) {
      return res.status(401).type("text").send("Unauthorized: missing or invalid ?token");
    }

    let decoded;
    try {
      decoded = JWT_PUBLIC_KEY
        ? jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ["RS256"] })
        : jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    } catch (err) {
      return res.status(401).type("text").send(`Unauthorized: invalid token (${err?.name})`);
    }

    const userId = decoded.sub || decoded._id || decoded.id || decoded.userId || decoded.user?.id;
    if (!userId) return res.status(401).type("text").send("Unauthorized: token missing user id");

    const role = roleFromDecoded(decoded);
    const isAdmin = role === "ADMIN";
    const scope = (req.query?.scope || "user").toLowerCase();
    const channel = isAdmin && scope === "admin" ? "admin" : String(userId);

    // ✅ SSE headers (streaming starts here)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write("retry: 10000\n\n");
    res.flushHeaders?.();

    // register client
    const set = global.sseClients.get(channel) || new Set();
    if (set.size >= MAX_CLIENTS_PER_USER) {
      sseWrite(res, { event: "error", data: { message: "too_many_connections" } });
      return res.end();
    }
    set.add(res);
    global.sseClients.set(channel, set);

    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    // INIT payload
    try {
      const Notification = mongoose.model("Notification");
      const limit = Math.min(Number(req.query?.limit) || 20, 100);
      const or =
        channel === "admin"
          ? [{ audience: "ADMIN" }, { audience: "ALL" }]
          : [{ user: userId }, { audience: "ALL" }];
      const initial = await Notification.find({ $or: or }).sort({ createdAt: -1 }).limit(limit).lean();
      sseWrite(res, { event: "init", data: { notifications: initial } });
    } catch {
      sseWrite(res, { event: "init", data: { notifications: [] } });
    }

    // keep alive
    const ping = setInterval(() => sseWriteRaw(res, `: ping ${Date.now()}\n\n`), HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(ping);
      const c = global.sseClients.get(channel);
      if (c) c.delete(res);
      if (!c || c.size === 0) global.sseClients.delete(channel);
    };

    req.on("close", cleanup);
    req.on("end", cleanup);
    res.on("error", cleanup);
  } catch (err) {
    debug("sseHandler error:", err?.message);
    if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
  }
};

/* ------------------------ Push helpers ---------------------------- */
function pushToChannel(channelKey, payload, { eventName } = {}) {
  const set = global.sseClients.get(String(channelKey));
  if (!set) return 0;
  const event = eventName || "message";
  for (const res of [...set]) sseWrite(res, { event, data: payload });
  return set.size;
}

export const pushToUser = (userId, payload, opts = {}) => pushToChannel(String(userId), payload, opts);
export const pushToAdmins = (payload, opts = {}) => pushToChannel("admin", payload, opts);

export const pushNotification = (doc) => {
  const payload = doc.toObject ? doc.toObject() : doc;
  if (payload.audience === "ADMIN") return pushToAdmins(payload, { eventName: "notification" });
  if (payload.audience === "ALL") {
    pushToAdmins(payload, { eventName: "notification" });
    if (payload.user) pushToUser(payload.user, payload, { eventName: "notification" });
    return;
  }
  if (payload.user) pushToUser(payload.user, payload, { eventName: "notification" });
};

/* ---------------------- Analytics Snapshot ------------------------ */
export async function emitAnalyticsSnapshot(options = {}) { /* unchanged */ }

/* ---------------------- Booking Watcher --------------------------- */
export function startBookingWatcher() { /* unchanged */ }

export default {
  sseHandler,
  ssePreflight,
  pushToUser,
  pushToAdmins,
  pushNotification,
  emitAnalyticsSnapshot,
  startBookingWatcher,
};
