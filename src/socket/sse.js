// backend/src/socket/sse.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import debugFactory from "debug";

const debug = debugFactory("app:sse");

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_BASE64 ||
  "dev_jwt_secret_change_me";
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || null;

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 10000);
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

global.sseClients = global.sseClients || new Map();

function sseWriteRaw(res, str) {
  if (!res || res.writableEnded || res.destroyed) return false;
  res.write(str);
  return true;
}

function sseWrite(res, { event, id, data }) {
  if (event) sseWriteRaw(res, `event: ${event}\n`);
  if (id) sseWriteRaw(res, `id: ${id}\n`);
  sseWriteRaw(res, `data: ${JSON.stringify(data)}\n\n`);
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
  const authHeader = req.headers.authorization || "";
  const cookies = parseCookie(req.headers.cookie || "");
  return (
    (authHeader.startsWith("Bearer ") && authHeader.slice(7)) ||
    req.query?.token ||
    cookies.token ||
    cookies.access_token ||
    cookies.jwt ||
    null
  );
}

function roleFrom(decoded) {
  return String(decoded?.role || decoded?.roles?.[0] || "USER")
    .toUpperCase()
    .includes("ADMIN")
    ? "ADMIN"
    : "USER";
}

export const ssePreflight = (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID, X-Role, Origin");
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.sendStatus(204);
};

export const sseHandler = async (req, res) => {
  try {
    req.socket?.setKeepAlive?.(true);
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);

    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    const rawToken = extractToken(req);
    const token = rawToken ? String(rawToken).trim() : null;
    if (!token || !token.includes(".")) return res.status(401).end("Unauthorized");

    let decoded;
    decoded = JWT_PUBLIC_KEY
      ? jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ["RS256"] })
      : jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });

    const userId = decoded.sub || decoded.id || decoded.userId || decoded.user?.id;
    if (!userId) return res.status(401).end("Unauthorized");

    const role = roleFrom(decoded);
    const scope = String(req.query.scope || "user").toLowerCase();
    const channel = role === "ADMIN" && scope === "admin" ? "admin" : String(userId);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Accel-Buffering", "no");

    sseWriteRaw(res, "retry: 10000\n");
    sseWriteRaw(res, `: hello ${Date.now()}\n\n`);
    res.flushHeaders?.();

    const set = global.sseClients.get(channel) || new Set();
    if (set.size >= MAX_CLIENTS_PER_USER) return res.end();
    set.add(res);
    global.sseClients.set(channel, set);

    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    try {
      const Notification = mongoose.model("Notification");
      const initial = await Notification.find({}).sort({ createdAt: -1 }).limit(20).lean();
      sseWrite(res, { event: "init", data: { notifications: initial } });
    } catch {
      sseWrite(res, { event: "init", data: { notifications: [] } });
    }

    const ping = setInterval(() => {
      sseWriteRaw(res, `: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(ping);
      const c = global.sseClients.get(channel);
      if (c) c.delete(res);
      if (c?.size === 0) global.sseClients.delete(channel);
    };

    req.on("close", cleanup);
    res.on("error", cleanup);
  } catch (err) {
    debug("sseHandler error:", err);
    if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
  }
};

export const pushToAdmins = (payload) =>
  (global.sseClients.get("admin") || new Set()).forEach((res) =>
    sseWrite(res, { event: "notification", data: payload })
  );

export const pushToUser = (userId, payload) =>
  (global.sseClients.get(String(userId)) || new Set()).forEach((res) =>
    sseWrite(res, { event: "notification", data: payload })
  );
