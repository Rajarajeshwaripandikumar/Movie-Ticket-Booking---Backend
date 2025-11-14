// backend/src/socket/sse.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import debugFactory from "debug";

const debug = debugFactory("app:sse");

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_BASE64 ||
  "dev_jwt_secret_change_me";

const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || null;

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 10000);
const MAX_CLIENTS_PER_USER = parseInt(
  process.env.SSE_MAX_CLIENTS_PER_USER || "8",
  10
);

// Global registry
global.sseClients = global.sseClients || new Map();

/* -------------------------------------------------------------------------- */
/*                                   UTILS                                    */
/* -------------------------------------------------------------------------- */
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
    if (i > -1)
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
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

/* -------------------------------------------------------------------------- */
/*                               ROLE NORMALIZER                              */
/* -------------------------------------------------------------------------- */
function normalizeRole(raw) {
  const v = String(raw || "").trim().toUpperCase();

  if (v.includes("SUPER")) return "SUPER_ADMIN";
  if (v.includes("THEATRE") || v.includes("THEATER")) return "THEATRE_ADMIN";
  if (v === "ADMIN") return "ADMIN";
  return "USER";
}

function computeChannel(role, userId) {
  if (role === "SUPER_ADMIN") return "super_admin";
  if (role === "ADMIN") return "admin";
  if (role === "THEATRE_ADMIN") return `theatre_admin_${userId}`;
  return String(userId);
}

/* -------------------------------------------------------------------------- */
/*                               CORS PREFLIGHT                               */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*                                SSE HANDLER                                 */
/* -------------------------------------------------------------------------- */
export const sseHandler = async (req, res) => {
  try {
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true);
    req.socket?.setTimeout?.(0);

    // CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    // Token
    const token = extractToken(req);
    if (!token || !token.includes(".")) return res.status(401).end("Unauthorized");

    const decoded = JWT_PUBLIC_KEY
      ? jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ["RS256"] })
      : jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });

    const userId =
      decoded.sub ||
      decoded.id ||
      decoded.userId ||
      decoded.user?.id ||
      decoded._id;

    if (!userId) return res.status(401).end("Unauthorized");

    const role = normalizeRole(decoded.role);
    const channel = computeChannel(role, userId);

    // Limit multi-tabs
    const set = global.sseClients.get(channel) || new Set();
    if (set.size >= MAX_CLIENTS_PER_USER) {
      return res.end();
    }

    /* ---------------- SSE RESPONSE HEADERS ---------------- */
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Accel-Buffering", "no");

    sseWriteRaw(res, "retry: 10000\n\n");
    res.flushHeaders?.();

    /* ---------------- Register client ---------------- */
    set.add(res);
    global.sseClients.set(channel, set);

    debug("Connected:", channel, "listeners:", set.size);

    sseWrite(res, {
      event: "connected",
      data: { channel, role, ts: Date.now() },
    });

    /* ---- IMPORTANT ----
       Initial seeding is handled by notifications.routes.js
       to avoid conflicts.
    */

    /* ---------------- Heartbeat ---------------- */
    const hb = setInterval(() => {
      sseWriteRaw(res, `: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(hb);
      const s = global.sseClients.get(channel);
      if (s) {
        s.delete(res);
        if (s.size === 0) global.sseClients.delete(channel);
      }
    };

    req.on("close", cleanup);
    res.on("error", cleanup);
  } catch (err) {
    debug("SSE error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ message: "SSE error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                           PUSH HELPERS (merged)                            */
/* -------------------------------------------------------------------------- */

export function pushToAdmins(payload) {
  let delivered = 0;

  for (const ch of ["admin", "super_admin"]) {
    const set = global.sseClients.get(ch);
    if (!set) continue;
    for (const res of set) {
      if (!res || res.destroyed) continue;
      sseWrite(res, { event: "notification", data: payload });
      delivered++;
    }
  }

  return delivered;
}

export function pushToUser(userId, payload) {
  const set = global.sseClients.get(String(userId));
  if (!set) return 0;

  let delivered = 0;
  for (const res of set) {
    sseWrite(res, { event: "notification", data: payload });
    delivered++;
  }
  return delivered;
}

export function pushToAll(payload) {
  let delivered = 0;
  for (const [channel, set] of global.sseClients.entries()) {
    for (const res of set) {
      sseWrite(res, { event: "notification", data: payload });
      delivered++;
    }
  }
  return delivered;
}

export default {
  sseHandler,
  ssePreflight,
  pushToAdmins,
  pushToUser,
  pushToAll,
};
