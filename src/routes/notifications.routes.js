// backend/src/routes/notifications.routes.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import Notification from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../utils/sendEmail.js"; // NEW: email helper

const router = Router();

// In-memory registry (channel -> Set<Response>)
// channel is either a userId (string) or the literal "admin"
const clients = new Map();

const JWT_SECRET   = process.env.JWT_SECRET   || "dev_jwt_secret_change_me";
const CORS_ORIGIN  = process.env.CORS_ORIGIN  || "*";
const HEARTBEAT_MS = 25_000;

/* -------------------------- helpers -------------------------- */
function sseWrite(res, { event = "notification", id, data }) {
  if (res._sseWritable && !res._sseWritable()) return;
  if (event) res.write(`event: ${event}\n`);
  if (id)    res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function heartbeat(res) {
  if (res._sseWritable && !res._sseWritable()) return;
  res.write(`: heartbeat ${Date.now()}\n\n`);
}

// Extract { userId, role } from Authorization: Bearer <token> or ?token=
function getAuthFromReq(req) {
  const h = req.headers.authorization;
  const token = h?.startsWith("Bearer ") ? h.slice(7) : (req.query.token || null);
  if (!token) return { userId: null, role: null, raw: null };
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.sub || decoded.id || decoded.userId || decoded._id;
    // role claim examples: "ADMIN", "USER", "ROLE_ADMIN"
    const roleRaw =
      decoded.role ||
      (Array.isArray(decoded.roles) && decoded.roles.find(r => String(r).toUpperCase().includes("ADMIN"))) ||
      null;
    const role = String(roleRaw || "USER").toUpperCase().includes("ADMIN") ? "ADMIN" : "USER";
    return { userId: userId ? String(userId) : null, role, raw: decoded };
  } catch {
    return { userId: null, role: null, raw: null };
  }
}

function addClient(channel, res) {
  if (!clients.has(channel)) clients.set(channel, new Set());
  clients.get(channel).add(res);
}

function removeClient(channel, res) {
  const set = clients.get(channel);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(channel);
}

/* ---------- read/unread + visibility helpers (readBy-aware) ---------- */
function isAdminRole(roleOrUser) {
  const r = typeof roleOrUser === "string" ? roleOrUser : roleOrUser?.role;
  return String(r || "").toUpperCase().includes("ADMIN");
}
function readerFor({ role, _id }) {
  return isAdminRole(role) ? "admin" : String(_id);
}

/** Items visible to the caller */
function visibilityOr({ isAdmin, userId, includeAll = true }) {
  if (isAdmin) {
    const or = [{ audience: "ADMIN" }];
    if (includeAll) or.push({ audience: "ALL" });
    return or;
  }
  const or = [
    // user-scoped + back-compat (audience may be missing/USER)
    { user: userId, $or: [{ audience: { $exists: false } }, { audience: null }, { audience: "USER" }] },
  ];
  if (includeAll) {
    // ALL intended for everyone (usually has user: null)
    or.push({ audience: "ALL" });
  }
  return or;
}

/** Unread condition supporting readBy (primary) and readAt (legacy for user items) */
function unreadCond(readerId) {
  return {
    $and: [
      { $or: [{ readBy: { $exists: false } }, { readBy: { $nin: [readerId] } }] },
      { $or: [{ readAt: { $exists: false } }, { readAt: null }] }, // keep legacy readAt compatibility
    ],
  };
}

/* -------------------------- routes -------------------------- */
// Health
router.get("/", (_req, res) => res.json({ status: "ok" }));

// Debug: list connected clients
router.get("/_debug/clients", (_req, res) => {
  const out = [];
  for (const [ch, set] of clients.entries()) out.push({ channel: ch, listeners: set.size });
  res.json(out);
});

// CORS preflight (if no global CORS)
router.options("/stream", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.status(204).end();
});

// ---- SSE stream with token in query OR Authorization header ----
// Add ?scope=admin to subscribe to admin channel (for admins)
router.get("/stream", async (req, res) => {
  const auth = getAuthFromReq(req);
  const { userId, role } = auth;
  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  const scope = String(req.query.scope || "user").toLowerCase();
  const isAdmin = role === "ADMIN";
  const channel = isAdmin && scope === "admin" ? "admin" : String(userId);

  // SSE / CORS headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // Improve socket behavior for long-lived streams
  req.socket?.setKeepAlive?.(true, 30_000);
  req.socket?.setNoDelay?.(true);

  // reconnection backoff (ms) for EventSource
  res.write("retry: 10000\n\n");
  res.flushHeaders?.();

  addClient(channel, res);

  // mark response as writable until closed
  res._sseWritable = () => !res.writableEnded && !res.destroyed;

  const listeners = clients.get(channel)?.size || 0;
  console.log(`[SSE] CONNECT channel=${channel} listeners=${listeners}`);

  // initial hello event
  sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

  // (Optional) seed recent on connect: /stream?seed=1
  if (String(req.query.seed || "") === "1") {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const or = channel === "admin"
        ? visibilityOr({ isAdmin: true, userId: null })
        : visibilityOr({ isAdmin: false, userId: userId });

      const items = await Notification.find({ $or: or })
        .sort({ readAt: 1, createdAt: -1 })
        .limit(limit)
        .lean();

      for (const n of items) {
        sseWrite(res, { id: n._id, data: n }); // event defaults to "notification"
      }
    } catch (e) {
      sseWrite(res, { event: "error", data: { message: "seed_failed" } });
    }
  }

  const hb = setInterval(() => heartbeat(res), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(hb);
    removeClient(channel, res);
    console.log(`[SSE] CLOSE channel=${channel}`);
  });
});

/* -------------------- Broadcast helpers -------------------- */
export function broadcastToUser(userId, payload) {
  const key = String(userId);
  const set = clients.get(key);
  const listeners = set?.size || 0;
  console.log(
    `[SSE] broadcastToUser channel=${key} listeners=${listeners} payloadId=${payload?._id || "-"} type=${payload?.type || "-"}`
  );
  if (!set) return 0;
  let delivered = 0;
  for (const r of set) {
    if (r._sseWritable && !r._sseWritable()) continue;
    sseWrite(r, { id: payload?._id, data: payload }); // always "notification"
    delivered++;
  }
  console.log(`[SSE] delivered=${delivered} to channel=${key}`);
  return delivered;
}

export function broadcastToAdmins(payload) {
  const key = "admin";
  const set = clients.get(key);
  const listeners = set?.size || 0;
  console.log(
    `[SSE] broadcastToAdmins channel=${key} listeners=${listeners} payloadId=${payload?._id || "-"} type=${payload?.type || "-"}`
  );
  if (!set) return 0;
  let delivered = 0;
  for (const r of set) {
    if (r._sseWritable && !r._sseWritable()) continue;
    sseWrite(r, { id: payload?._id, data: payload });
    delivered++;
  }
  console.log(`[SSE] delivered=${delivered} to channel=${key}`);
  return delivered;
}

export function broadcastAll(payload) {
  let delivered = 0;
  for (const [uid, set] of clients.entries()) {
    const listeners = set?.size || 0;
    console.log(
      `[SSE] broadcastAll -> channel=${uid} listeners=${listeners} payloadId=${payload?._id || "-"} type=${payload?.type || "-"}`
    );
    for (const r of set) {
      if (r._sseWritable && !r._sseWritable()) continue;
      sseWrite(r, { id: payload?._id, data: payload });
      delivered++;
    }
  }
  console.log(`[SSE] broadcastAll delivered=${delivered} total`);
  return delivered;
}

/**
 * Push a saved Notification document to the correct channel after you create it.
 *   const doc = await Notification.create(...);
 *   pushNotification(doc);
 *
 *  NOTE: this function now attempts to send an email (if an address is available)
 *        while preserving your existing SSE broadcast behavior.
 */
export async function pushNotification(doc) {
  if (!doc) return 0;

  const payload = doc.toObject ? doc.toObject() : doc;
  const audience = payload.audience;

  // 1) SSE broadcast (unchanged)
  let delivered = 0;
  if (audience === "ADMIN") {
    delivered += broadcastToAdmins(payload);
  } else if (audience === "ALL") {
    delivered += broadcastToAdmins(payload);
    if (payload.user) delivered += broadcastToUser(String(payload.user), payload);
  } else {
    const userId = payload.user ? String(payload.user._id || payload.user) : null;
    if (userId) delivered += broadcastToUser(userId, payload);
  }

  // 2) Email (best-effort) — will not throw (errors logged)
  try {
    // Determine recipient email:
    // - If Notification doc includes an email field or user.email, use it
    // - Fallback to SUPPORT_EMAIL or ADMIN email env var if set (useful for admin/ALL)
    const recipient =
      payload.email ||
      (payload.user && (payload.user.email || payload.user.emailAddress)) ||
      process.env.SUPPORT_EMAIL ||
      process.env.NOTIFICATIONS_FALLBACK_EMAIL ||
      null;

    if (recipient) {
      const subject = payload.title || payload.type || "MovieBook Notification";
      const html = `
        <div>
          <h3>${payload.title || payload.type || "Notification"}</h3>
          <p>${payload.message || payload.body || ""}</p>
          <hr/>
          <small>This is an automated message from MovieBook</small>
        </div>
      `;
      // sendEmail returns true/false — best-effort
      const ok = await sendEmail({ to: recipient, subject, html });
      console.log(`[pushNotification] email_sent=${ok} to=${recipient} id=${String(payload._id || "")}`);
    } else {
      console.log(`[pushNotification] no email target for notification id=${String(payload._id || "")}`);
    }
  } catch (err) {
    console.error("[pushNotification] email error:", err?.message || err);
  }

  return delivered;
}

// ---- dev-only: simulate a notification ----
router.post("/notify", (req, res) => {
  const { userId, payload, audience } = req.body || {};
  const msg = payload ?? { type: "INFO", title: "Ping", message: "Hello!" };
  let delivered = 0;
  if (audience === "ADMIN") delivered = broadcastToAdmins(msg);
  else if (userId) delivered = broadcastToUser(userId, msg);
  else delivered = broadcastAll(msg);
  res.json({ delivered });
});

/* --------------- REST: list / counts / mark read (readBy-aware) --------------- */
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.user);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;
    const { unread, limit = 50 } = req.query;

    const q = { $or: visibilityOr({ isAdmin, userId, includeAll: true }) };
    if (String(unread) === "1") Object.assign(q, unreadCond(readerId));

    const items = await Notification.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .lean();

    res.json(items);
  } catch (e) {
    console.error("[notifications] list error:", e?.message);
    res.status(500).json({ message: "Failed to load notifications" });
  }
});

router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.user);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    const n = await Notification.countDocuments({
      $and: [
        { $or: visibilityOr({ isAdmin, userId, includeAll: true }) },
        unreadCond(readerId),
      ],
    });

    res.json({ count: n });
  } catch (e) {
    console.error("[notifications] count error:", e?.message);
    res.status(500).json({ message: "Failed to load unread count" });
  }
});

router.patch("/:id/read", requireAuth, async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.user);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;
    const { id } = req.params;

    // must be visible to caller
    const vis = visibilityOr({ isAdmin, userId, includeAll: true });

    // fetch first (we need to know audience & user to decide readAt legacy)
    const doc = await Notification.findOne({ _id: id, $or: vis });
    if (!doc) return res.status(404).json({ message: "Not found" });

    const update = { $addToSet: { readBy: readerId } };

    // Back-compat: if it's a USER/legacy item for this exact user, set readAt too
    const isUserItemForCaller =
      !isAdmin &&
      String(doc.user || "") === userId &&
      (doc.audience === "USER" || doc.audience == null);

    if (isUserItemForCaller && !doc.readAt) {
      update.$set = { readAt: new Date() };
    }

    const updated = await Notification.findByIdAndUpdate(id, update, { new: true });
    res.json(updated);
  } catch (e) {
    console.error("[notifications] mark read error:", e?.message);
    res.status(500).json({ message: "Failed to mark read" });
  }
});

router.post("/read-all", requireAuth, async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.user);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    // visible to caller
    const vis = visibilityOr({ isAdmin, userId, includeAll: true });

    // add caller to readBy; also set readAt for legacy user docs
    const update = { $addToSet: { readBy: readerId } };
    if (!isAdmin) update.$set = { readAt: new Date() };

    const r = await Notification.updateMany({ $or: vis }, update);
    res.json({ modified: r.modifiedCount || r.nModified || 0 });
  } catch (e) {
    console.error("[notifications] read-all error:", e?.message);
    res.status(500).json({ message: "Failed to mark all read" });
  }
});

export default router;
