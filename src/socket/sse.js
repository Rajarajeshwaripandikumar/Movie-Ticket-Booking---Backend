// improved-sse.js
import jwt from "jsonwebtoken";
import Notification from "../models/Notification.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5173";
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

// tiny cookie parser
function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function sseWriteRaw(res, str) {
  try {
    if (!res || res.writableEnded || res.destroyed) return false;
    res.write(str);
    return true;
  } catch (err) {
    return false;
  }
}

function sseWrite(res, { event, id, data }) {
  // guard: ensure we aren't writing to a closed stream
  if (!res || res.writableEnded || res.destroyed) return false;
  if (event) sseWriteRaw(res, `event: ${event}\n`);
  if (id) sseWriteRaw(res, `id: ${id}\n`);
  sseWriteRaw(res, `data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function extractToken(req) {
  const authHeader = req.headers.authorization || "";
  const cookies = parseCookie(req.headers.cookie || "");
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token && req.query && typeof req.query.token === "string") token = req.query.token;
  if (!token && req.params && typeof req.params.token === "string") token = req.params.token;
  if (!token && cookies.token) token = cookies.token;
  if (!token && cookies.access_token) token = cookies.access_token;
  if (!token && cookies.jwt) token = cookies.jwt;
  if (!token && req.originalUrl) {
    try {
      const full = new URL(req.originalUrl, `http://${req.headers.host}`);
      const qp = full.searchParams.get("token");
      if (qp) token = qp;
    } catch {}
  }
  return { token, authHeader, cookies };
}

function roleFromDecoded(decoded) {
  const r =
    decoded?.role ||
    (Array.isArray(decoded?.roles) && decoded.roles.find((x) => String(x).toUpperCase().includes("ADMIN"))) ||
    "USER";
  return String(r).toUpperCase().includes("ADMIN") ? "ADMIN" : "USER";
}

global.sseClients = global.sseClients || new Map();

/** CORS preflight kept as you had it */
export const ssePreflight = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, last-event-id");
  res.status(204).end();
};

export const sseHandler = async (req, res) => {
  try {
    const { token, authHeader, cookies } = extractToken(req);

    // Dev debug
    console.log("SSE: URL:", req.originalUrl, "Auth header?", Boolean(authHeader), "cookieKeys:", Object.keys(cookies), "token?", Boolean(token));

    if (!token) return res.status(401).json({ message: "Unauthorized: missing token" });

    let decoded;
    try {
      // tighten verification: optionally restrict algorithms if you use HS256 only
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"], ignoreExpiration: false });
    } catch (err) {
      console.error("❌ Invalid JWT in SSE:", err.message);
      return res.status(401).json({ message: "Unauthorized: invalid token" });
    }

    const userId = String(decoded._id || decoded.id || decoded.userId || "");
    if (!userId) {
      console.error("❌ JWT missing user id field:", decoded);
      return res.status(401).json({ message: "Unauthorized: invalid payload" });
    }
    const role = roleFromDecoded(decoded);
    const isAdmin = role === "ADMIN";

    // admin can opt into admin channel with ?scope=admin
    const scope = String(req.query?.scope || "user").toLowerCase();
    const channel = isAdmin && scope === "admin" ? "admin" : userId;

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    // notify client how long to retry (ms)
    res.write("retry: 10000\n\n");
    res.flushHeaders?.();

    // Enforce soft cap
    const current = global.sseClients.get(channel) || new Set();
    if (current.size >= MAX_CLIENTS_PER_USER) {
      sseWrite(res, { event: "error", data: { message: "too_many_connections" } });
      return res.end();
    }

    // Register client
    current.add(res);
    global.sseClients.set(channel, current);
    console.log(`🔗 SSE connection established for channel: ${channel} (clients=${current.size})`);

    // mark writable-check helper (optional)
    res._isSseAlive = () => !res.writableEnded && !res.destroyed;

    // send connected event (use a small payload)
    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    // INIT: send recent items (trim projection to keep size reasonable)
    const limit = Math.min(Number(req.query?.limit) || 20, 100);
    const or = channel === "admin" ? [{ audience: "ADMIN" }, { audience: "ALL" }] : [{ user: userId, $or: [{ audience: { $exists: false } }, { audience: null }, { audience: "USER" }] }, { audience: "ALL" }];
    const initial = await Notification.find({ $or: or })
      .select("-__v") // drop mongoose version field
      .sort({ createdAt: -1 }) // most recent first
      .limit(limit)
      .lean();

    sseWrite(res, { event: "init", data: { notifications: initial } });

    // heartbeat
    const ping = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      sseWriteRaw(res, `: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    // cleanup helper
    const cleanup = () => {
      try {
        clearInterval(ping);
      } catch {}
      const bucket = global.sseClients.get(channel);
      if (bucket) {
        bucket.delete(res);
        if (bucket.size === 0) global.sseClients.delete(channel);
      }
      console.log(`❌ SSE disconnected for channel: ${channel} (remaining=${global.sseClients.get(channel)?.size ?? 0})`);
    };

    req.on("close", cleanup);
    req.on("end", cleanup);
    res.on("error", (err) => {
      // socket-level error; remove client
      console.warn("SSE socket error:", err && err.message);
      cleanup();
    });

    // Optionally handle Last-Event-ID from client to resume (req.headers['last-event-id'])
    // const lastEventId = req.headers["last-event-id"] || req.query.lastEventId;

  } catch (err) {
    console.error("SSE handler error:", err);
    if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
  }
};

/** Push helpers that remove dead clients when writes fail */
function pushToChannel(channelKey, payload) {
  const set = global.sseClients?.get(String(channelKey));
  if (!set || set.size === 0) return 0;

  const isNotification = payload && (payload.type || payload._id);
  const event = isNotification ? "notification" : "message";
  const id = payload?._id;

  let delivered = 0;
  for (const res of Array.from(set)) {
    try {
      const ok = sseWrite(res, { event, id, data: payload });
      if (!ok) {
        // remove broken stream
        set.delete(res);
        continue;
      }
      delivered++;
    } catch (err) {
      // remove on any failure
      set.delete(res);
    }
  }
  // cleanup empty bucket
  if (set.size === 0) global.sseClients.delete(String(channelKey));
  return delivered;
}

export const pushToUser = (userId, payload) => pushToChannel(String(userId), payload);
export const pushToAdmins = (payload) => pushToChannel("admin", payload);

export const pushNotification = (doc) => {
  if (!doc) return 0;
  // doc may already be a POJO or a mongoose doc
  const payload = doc.toObject ? doc.toObject() : doc;
  const audience = payload.audience;
  if (audience === "ADMIN") {
    return pushToAdmins(payload);
  }
  if (audience === "ALL") {
    let delivered = 0;
    delivered += pushToAdmins(payload);
    if (payload.user) delivered += pushToUser(String(payload.user), payload);
    return delivered;
  }
  const userId = payload.user ? String(payload.user._id || payload.user) : null;
  return userId ? pushToUser(userId, payload) : 0;
};

/**
 * Optional: wire a mongoose "watch" or post-save hook to auto-publish notifications
 * Example (in your Notification model init code):
 *
 * // 1) post-save hook
 * NotificationSchema.post("save", function(doc) {
 *   import { pushNotification } from "./improved-sse.js"; // relative path as needed
 *   // choose to send only when published flag or created
 *   pushNotification(doc);
 * });
 *
 * // 2) Or use change streams (if you run a replica set / production Mongo)
 * const changeStream = Notification.watch();
 * changeStream.on("change", (change) => {
 *   if (change.operationType === "insert") {
 *     const doc = change.fullDocument;
 *     pushNotification(doc);
 *   }
 * });
 *
 * Note: change streams require a replica set (or atlas).
 */
