// backend/src/routes/notifications.routes.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import Notification from "../models/Notification.js";
import NotificationPref from "../models/NotificationPref.js";
import { requireAuth } from "../middleware/auth.js";
import mailer, { renderTemplate } from "../models/mailer.js"; // use your mailer wrapper (sendEmail function)

const router = Router();

/* -------------------------------------------------------------------------- */
/*                               SSE REGISTRY                                 */
/* -------------------------------------------------------------------------- */
// channel → Set<Response>
const clients = new Map();

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const HEARTBEAT_MS = 25000;

/* -------------------------------------------------------------------------- */
/*                                 SSE UTILS                                  */
/* -------------------------------------------------------------------------- */
function sseWrite(res, { event = "notification", id, data }) {
  if (!res._sseWritable || !res._sseWritable()) return;
  if (event) res.write(`event: ${event}\n`);
  if (id) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function heartbeat(res) {
  if (!res._sseWritable || !res._sseWritable()) return;
  res.write(`: heartbeat ${Date.now()}\n\n`);
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

/* -------------------------------------------------------------------------- */
/*                               AUTH HELPERS                                 */
/* -------------------------------------------------------------------------- */
function getAuthFromReq(req) {
  const h = req.headers.authorization;
  const token = h?.startsWith("Bearer ") ? h.slice(7) : req.query.token;

  if (!token) return { userId: null, role: null };

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId =
      decoded.sub || decoded.id || decoded.userId || decoded._id || null;

    // accept role names like USER, ADMIN, SUPER_ADMIN, THEATER_ADMIN
    const roleRaw =
      decoded.role ||
      (Array.isArray(decoded.roles) && decoded.roles.find(Boolean)) ||
      null;

    const role = roleRaw ? String(roleRaw).toUpperCase() : "USER";

    return { userId: String(userId), role };
  } catch {
    return { userId: null, role: null };
  }
}

function isAdminRole(roleOrUser) {
  const r = typeof roleOrUser === "string" ? roleOrUser : roleOrUser?.role;
  if (!r) return false;
  const ru = String(r).toUpperCase();
  return ru.includes("ADMIN") || ru.includes("SUPER_ADMIN") || ru.includes("THEATER_ADMIN");
}

function readerFor({ role, _id }) {
  return isAdminRole(role) ? "admin" : String(_id);
}

/* -------------------------------------------------------------------------- */
/*                           VISIBILITY / UNREAD HELPERS                      */
/* -------------------------------------------------------------------------- */
function visibilityOr({ isAdmin, userId, includeAll = true }) {
  if (isAdmin) {
    const or = [{ audience: "ADMIN" }];
    if (includeAll) or.push({ audience: "ALL" });
    return or;
  }

  const or = [
    {
      user: userId,
      $or: [{ audience: { $exists: false } }, { audience: null }, { audience: "USER" }],
    },
  ];

  if (includeAll) or.push({ audience: "ALL" });

  return or;
}

function unreadCond(readerId) {
  return {
    $and: [
      { $or: [{ readBy: { $exists: false } }, { readBy: { $nin: [readerId] } }] },
      { $or: [{ readAt: { $exists: false } }, { readAt: null }] },
    ],
  };
}

function canSeeNotification({ doc, isAdmin, userId }) {
  if (!doc) return false;
  if (doc.audience === "ADMIN") return isAdmin;
  if (doc.audience === "ALL") return true;
  return String(doc.user || "") === String(userId);
}

/* -------------------------------------------------------------------------- */
/*                                   ROUTES                                   */
/* -------------------------------------------------------------------------- */
router.get("/", (_req, res) => res.json({ status: "ok" }));

router.get("/_debug/clients", (_req, res) => {
  const out = [];
  for (const [ch, set] of clients.entries()) out.push({ channel: ch, listeners: set.size });
  res.json(out);
});

/* -------------------------------------------------------------------------- */
/*                                SSE STREAM                                  */
/* -------------------------------------------------------------------------- */
router.options("/stream", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.status(204).end();
});

router.get("/stream", (req, res) => {
  const { userId, role } = getAuthFromReq(req);
  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  const scope = String(req.query.scope || "user").toLowerCase();
  const isAdmin = isAdminRole(role);
  const channel = isAdmin && scope === "admin" ? "admin" : String(userId);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");

  req.socket?.setKeepAlive?.(true, 30000);
  req.socket?.setNoDelay?.(true);

  res.write("retry: 10000\n\n");
  res.flushHeaders?.();

  addClient(channel, res);
  res._sseWritable = () => !res.writableEnded && !res.destroyed;

  console.log(`[SSE] CONNECT channel=${channel}`);

  sseWrite(res, {
    event: "connected",
    data: { channel, role, ts: Date.now() },
  });

  const hb = setInterval(() => heartbeat(res), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(hb);
    removeClient(channel, res);
    console.log(`[SSE] CLOSE channel=${channel}`);
  });
});

/* -------------------------------------------------------------------------- */
/*                              BROADCAST HELPERS                             */
/* -------------------------------------------------------------------------- */
export function broadcastToUser(userId, payload) {
  const key = String(userId);
  const set = clients.get(key);
  if (!set) return 0;

  let delivered = 0;
  for (const r of set) {
    if (r._sseWritable && !r._sseWritable()) continue;
    sseWrite(r, { id: payload?._id, data: payload });
    delivered++;
  }
  return delivered;
}

export function broadcastToAdmins(payload) {
  const set = clients.get("admin");
  if (!set) return 0;

  let delivered = 0;
  for (const r of set) {
    if (r._sseWritable && !r._sseWritable()) continue;
    sseWrite(r, { id: payload?._id, data: payload });
    delivered++;
  }
  return delivered;
}

export function broadcastAll(payload) {
  let delivered = 0;
  for (const [channel, set] of clients.entries()) {
    for (const r of set) {
      if (r._sseWritable && !r._sseWritable()) continue;
      sseWrite(r, { id: payload?._id, data: payload });
      delivered++;
    }
  }
  return delivered;
}

/* -------------------------------------------------------------------------- */
/*                   REAL PUSH AFTER SAVING A NOTIFICATION                    */
/* -------------------------------------------------------------------------- */

/**
 * Map notification.type to NotificationPref keys
 * Expand this if you add more types
 */
function prefKeyForType(type) {
  const t = String(type || "").toUpperCase();
  if (t.includes("CONFIRMED")) return "bookingConfirmed";
  if (t.includes("CANCELLED")) return "bookingCancelled";
  if (t.includes("REMINDER")) return "bookingReminder";
  if (t.includes("SHOWTIME")) return "showtimeChanged";
  if (t.includes("UPCOMING")) return "upcomingMovie";
  return null;
}

/**
 * pushNotification(doc)
 * - broadcasts via SSE to appropriate channel(s)
 * - sends email only if notification.channels includes "EMAIL" and user's prefs allow it
 */
export async function pushNotification(doc) {
  if (!doc) return 0;
  // normalize
  const payload = doc.toObject ? doc.toObject() : doc;
  let delivered = 0;

  try {
    switch (payload.audience) {
      case "ADMIN":
        delivered += broadcastToAdmins(payload);
        break;
      case "ALL":
        delivered += broadcastAll(payload);
        break;
      case "USER":
      default:
        if (payload.user) delivered += broadcastToUser(String(payload.user), payload);
        break;
    }
  } catch (err) {
    console.warn("[pushNotification] SSE broadcast error:", err?.message || err);
  }

  /* ------------ optional email ------------- */
  try {
    // Only attempt email if channel requests it
    const wantsEmail = Array.isArray(payload.channels) && payload.channels.includes("EMAIL");
    if (!wantsEmail) return delivered;

    // Determine recipient email
    let to = null;
    if (payload.email) to = payload.email;
    else if (payload.user && payload.user.email) to = payload.user.email;
    // If payload.user is an id only, we'll try to look up user's email below when checking prefs

    // Determine preference key
    const prefKey = prefKeyForType(payload.type);

    // If audience is USER, enforce user's NotificationPref
    if (payload.audience === "USER" && payload.user) {
      // payload.user may be populated or just an id
      const userId = typeof payload.user === "object" && payload.user._id ? String(payload.user._id) : String(payload.user);
      // Fetch pref and optionally user email if not present
      const [pref, userDoc] = await Promise.all([
        NotificationPref.findOne({ user: userId }).lean(),
        // We only need email if 'to' is null; try lean lookup
        (!to ? mongoose.model("User").findById(userId).select("email name").lean() : Promise.resolve(null)),
      ]);

      const allowEmail = prefKey ? Boolean(pref?.[prefKey]?.email) : true;
      if (!allowEmail) {
        // Respect user's preference: do not send email
        return delivered;
      }
      if (!to && userDoc?.email) to = userDoc.email;
    }

    // For ADMIN or ALL audience: allow sending email (admin notifications generally internal)
    if (!to) {
      // nothing to send to
      return delivered;
    }

    const subject = payload.title || payload.type || "Notification";
    const html = payload.html || renderTemplate?.("booking-confirmed", {
      name: payload.user?.name || "Customer",
      movieTitle: payload.data?.movieTitle || "",
      showtime: payload.data?.showtime || "",
      seats: payload.data?.seats || "",
      bookingId: payload.data?.bookingId || "",
      ticketViewUrl: payload.data?.ticketViewUrl || "#",
      ticketPdfUrl: payload.data?.ticketPdfUrl || "#",
    }) || `<h3>${subject}</h3><p>${payload.message || ""}</p>`;

    // send email using mailer wrapper
    const mailRes = await mailer.sendEmail({ to, subject, html, text: payload.message || undefined });
    if (!mailRes?.ok) {
      console.error("[pushNotification] Email failed:", mailRes?.error || "unknown");
    } else {
      // optionally, log preview url in dev
      console.log("[pushNotification] Email sent:", mailRes.messageId, mailRes.previewUrl || "");
    }
  } catch (err) {
    console.error("[pushNotification] email send error:", err?.message || err);
  }

  return delivered;
}

/* -------------------------------------------------------------------------- */
/*                             MANUAL DEV TESTING                             */
/* -------------------------------------------------------------------------- */
router.post("/notify", async (req, res) => {
  try {
    const { userId, audience, payload } = req.body || {};
    let delivered = 0;

    if (audience === "ADMIN") delivered = broadcastToAdmins(payload);
    else if (audience === "ALL") delivered = broadcastAll(payload);
    else if (userId) delivered = broadcastToUser(userId, payload);
    else delivered = broadcastAll(payload);

    return res.json({ delivered });
  } catch (err) {
    console.error("[notifications] /notify error:", err);
    return res.status(500).json({ delivered: 0 });
  }
});

/* -------------------------------------------------------------------------- */
/*                           LIST / COUNT / READ                              */
/* -------------------------------------------------------------------------- */
async function listMine(req, res) {
  try {
    if (!req.user) return res.status(401).json({ ok: false, items: [] });

    const isAdmin = isAdminRole(req.user.role);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    const { unread, limit = 50 } = req.query;

    const q = { $or: visibilityOr({ isAdmin, userId, includeAll: true }) };
    if (String(unread) === "1") Object.assign(q, unreadCond(readerId));

    const items = await Notification.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit), 100))
      .lean();

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("[notifications] listMine error:", err);
    return res.status(500).json({ ok: false, items: [] });
  }
}

router.get("/mine", requireAuth, listMine);
router.get("/me", requireAuth, listMine);

router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.user.role);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    const count = await Notification.countDocuments({
      $and: [{ $or: visibilityOr({ isAdmin, userId, includeAll: true }) }, unreadCond(readerId)],
    });

    return res.json({ ok: true, count });
  } catch (err) {
    console.error("[notifications] count error:", err);
    return res.status(500).json({ ok: false, count: 0 });
  }
});

router.patch("/:id/read", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

    const isAdmin = isAdminRole(req.user.role);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    const doc = await Notification.findById(id);
    if (!doc || !canSeeNotification({ doc, isAdmin, userId })) return res.status(404).json({ message: "Not found" });

    const update = { $addToSet: { readBy: readerId } };

    const isUserNote = !isAdmin && String(doc.user || "") === userId && (doc.audience === "USER" || doc.audience == null);
    if (isUserNote && !doc.readAt) update.$set = { readAt: new Date() };

    const updated = await Notification.findByIdAndUpdate(id, update, { new: true });

    return res.json({ ok: true, notification: updated });
  } catch (err) {
    console.error("[notifications] read error:", err);
    return res.status(500).json({ message: "Failed to mark read" });
  }
});

router.post("/read-all", requireAuth, async (req, res) => {
  try {
    const isAdmin = isAdminRole(req.user.role);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    const vis = visibilityOr({ isAdmin, userId, includeAll: true });

    const update = { $addToSet: { readBy: readerId } };
    if (!isAdmin) update.$set = { readAt: new Date() };

    const result = await Notification.updateMany({ $or: vis }, update);

    return res.json({ ok: true, modified: result.modifiedCount });
  } catch (err) {
    console.error("[notifications] read-all error:", err);
    return res.status(500).json({ ok: false, modified: 0 });
  }
});

/* -------------------------------------------------------------------------- */
/*                           DETAILS / OPEN                                   */
/* -------------------------------------------------------------------------- */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

    const isAdmin = isAdminRole(req.user.role);
    const userId = String(req.user._id);

    const doc = await Notification.findById(id).lean();
    if (!doc || !canSeeNotification({ doc, isAdmin, userId })) return res.status(404).json({ message: "Not found" });

    return res.json({ ok: true, notification: doc });
  } catch (err) {
    console.error("[notifications] detail error:", err);
    return res.status(500).json({ message: "Failed to load" });
  }
});

router.post("/:id/open", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

    const isAdmin = isAdminRole(req.user.role);
    const userId = String(req.user._id);
    const readerId = isAdmin ? "admin" : userId;

    const doc = await Notification.findById(id);
    if (!doc || !canSeeNotification({ doc, isAdmin, userId })) return res.status(404).json({ message: "Not found" });

    const update = { $addToSet: { readBy: readerId } };

    const isUserNote = !isAdmin && String(doc.user || "") === userId && (doc.audience === "USER" || doc.audience == null);
    if (isUserNote && !doc.readAt) update.$set = { readAt: new Date() };

    const updated = await Notification.findByIdAndUpdate(id, update, { new: true }).lean();

    return res.json({ ok: true, notification: updated });
  } catch (err) {
    console.error("[notifications] open error:", err);
    return res.status(500).json({ message: "Failed to open" });
  }
});

export default router;
