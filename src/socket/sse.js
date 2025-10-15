import jwt from "jsonwebtoken";
import Notification from "../models/Notification.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5173";
const HEARTBEAT_MS = 15000;
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

/** tiny cookie parser (no dependency) */
function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function sseWrite(res, { event, id, data }) {
  if (event) res.write(`event: ${event}\n`);
  if (id) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

/** Build OR filters that work for admin/user feeds and remain back-compatible */
function orFiltersForList({ isAdmin, userId, includeAll = true }) {
  const or = [];
  if (isAdmin) {
    // Admin feed: ADMIN + (optional) ALL
    or.push({ audience: "ADMIN" });
    if (includeAll) or.push({ audience: "ALL" });
  } else {
    // User feed: user scoped (back-compat: audience may be absent/USER) + (optional) ALL
    or.push({ user: userId, $or: [{ audience: { $exists: false } }, { audience: null }, { audience: "USER" }] });
    if (includeAll) or.push({ audience: "ALL" });
  }
  return or;
}

/** Global client registry: Map<channelKey, Set<Response>>
 * channelKey is either a userId string or the literal "admin"
 */
global.sseClients = global.sseClients || new Map();

export const ssePreflight = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, last-event-id");
  res.status(204).end();
};

export const sseHandler = async (req, res) => {
  try {
    const { token, authHeader, cookies } = extractToken(req);

    // Debug (keep during dev)
    console.log("----- SSE DEBUG -----");
    console.log("URL:", req.originalUrl);
    console.log("Has Authorization header:", Boolean(authHeader));
    console.log("Cookie keys:", Object.keys(cookies));
    console.log("Token present:", Boolean(token));
    console.log("---------------------");

    if (!token) return res.status(401).json({ message: "Unauthorized: missing token" });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
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
    res.write("retry: 10000\n\n");
    res.flushHeaders?.();

    // Enforce a soft cap on concurrent connections per channel
    const current = global.sseClients.get(channel) || new Set();
    if (current.size >= MAX_CLIENTS_PER_USER) {
      sseWrite(res, { event: "error", data: { message: "too_many_connections" } });
      return res.end();
    }

    // Register client
    current.add(res);
    global.sseClients.set(channel, current);
    console.log(`🔗 SSE connection established for channel: ${channel} (clients=${current.size})`);

    // Mark response writable until closed
    res._sseWritable = () => !res.writableEnded && !res.destroyed;

    // Connected event
    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    /**
     * INIT: send recent items
     * For admin channel: ADMIN (+ optional ALL)
     * For user channel:  USER (+ optional ALL)
     */
    const limit = Math.min(Number(req.query?.limit) || 20, 100);
    const or = channel === "admin" ? orFiltersForList({ isAdmin: true }) : orFiltersForList({ isAdmin: false, userId });
    const initial = await Notification.find({ $or: or })
      .sort({ readAt: 1, createdAt: -1 })
      .limit(limit)
      .lean();

    sseWrite(res, { event: "init", data: { notifications: initial } });

    // Keep alive
    const ping = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    // Cleanup
    req.on("close", () => {
      clearInterval(ping);
      const bucket = global.sseClients.get(channel);
      if (bucket) {
        bucket.delete(res);
        if (bucket.size === 0) global.sseClients.delete(channel);
      }
      console.log(`❌ SSE disconnected for channel: ${channel}`);
    });
  } catch (err) {
    console.error("SSE handler error:", err);
    if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
  }
};

/** Push helpers */
function pushToChannel(channelKey, payload) {
  const set = global.sseClients?.get(String(channelKey));
  if (!set || set.size === 0) return 0;

  const isNotification = payload && (payload.type || payload._id);
  const event = isNotification ? "notification" : "message";
  const id = payload?._id;

  let delivered = 0;
  for (const res of set) {
    try {
      sseWrite(res, { event, id, data: payload });
      delivered++;
    } catch {
      // ignore broken pipe
    }
  }
  return delivered;
}

export const pushToUser = (userId, payload) => pushToChannel(String(userId), payload);
export const pushToAdmins = (payload) => pushToChannel("admin", payload);

/**
 * Smart router for Notification docs: routes by `audience`
 *   - ADMIN  -> admin channel
 *   - ALL    -> admin + (optional) specific user if present
 *   - USER/* -> user channel (uses doc.user)
 */
export const pushNotification = (doc) => {
  if (!doc) return 0;
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
  // default user-scoped (back-compat)
  const userId = payload.user ? String(payload.user._id || payload.user) : null;
  return userId ? pushToUser(userId, payload) : 0;
};
