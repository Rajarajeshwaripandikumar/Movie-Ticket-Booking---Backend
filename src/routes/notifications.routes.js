// backend/src/routes/notifications.routes.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import Notification from "../models/Notification.js";
import NotificationPref from "../models/NotificationPref.js";
import { requireAuth } from "../middleware/auth.js";
import mailer, { renderTemplate } from "../models/mailer.js";
import User from "../models/User.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                               SSE REGISTRY                                 */
/* -------------------------------------------------------------------------- */
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

    const roleRaw =
      decoded.role ||
      (Array.isArray(decoded.roles) && decoded.roles.find(Boolean)) ||
      null;

    return {
      userId: String(userId),
      role: roleRaw ? String(roleRaw).toUpperCase() : "USER",
    };
  } catch {
    return { userId: null, role: null };
  }
}

const normRole = (role) => (role ? String(role).toUpperCase() : null);

function isAdminRole(roleOrUser) {
  const r = typeof roleOrUser === "string" ? roleOrUser : roleOrUser?.role;
  const ru = normRole(r);
  return (
    ru === "SUPER_ADMIN" ||
    ru === "THEATRE_ADMIN" ||
    ru === "THEATER_ADMIN" ||
    ru === "ADMIN"
  );
}

/* -------------------------------------------------------------------------- */
/*                           VISIBILITY / UNREAD HELPERS                      */
/* -------------------------------------------------------------------------- */

/**
 * visibilityOr({ role, userId, includeAll = true, userTheatreIds = [] })
 *
 * - For THEATRE_ADMIN / THEATER_ADMIN: returns OR clauses that match
 *   - theatre-specific admin notifications for the theatres the user belongs to
 *   - global notifications (audience: "ALL") if includeAll is true
 *
 * - For USER: returns user-specific and global notifications
 *
 * - For SUPER_ADMIN / ADMIN: returns broad clauses (no theatre scoping)
 */
function visibilityOr({ role, userId, includeAll = true, userTheatreIds = [] }) {
  const r = normRole(role);
  const vis = [];

  // SUPER ADMIN sees admin/theatre/admin-level + ALL (if requested)
  if (r === "SUPER_ADMIN") {
    vis.push({ audience: "ADMIN" });
    vis.push({ audience: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] } });
    if (includeAll) vis.push({ audience: "ALL" });
    return vis;
  }

  // THEATRE / THEATER ADMIN: scope to their theatre(s)
  if (r === "THEATRE_ADMIN" || r === "THEATER_ADMIN") {
    // build theatre-specific clause(s) if we have theatre ids
    if (Array.isArray(userTheatreIds) && userTheatreIds.length > 0) {
      const tObjs = userTheatreIds
        .filter(Boolean)
        .map((t) =>
          mongoose.Types.ObjectId.isValid(String(t))
            ? new mongoose.Types.ObjectId(String(t))
            : null
        )
        .filter(Boolean);

      if (tObjs.length > 0) {
        vis.push({
          $and: [
            { audience: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] } },
            {
              $or: [
                { theatreId: { $in: tObjs } },
                { theaterId: { $in: tObjs } },
                { theatre: { $in: tObjs } },
                { theater: { $in: tObjs } },
              ],
            },
          ],
        });
      } else {
        // fallback: no theatre ids available — include theatre-admin audience but no theatre filter
        vis.push({ audience: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] } });
      }
    } else {
      // no theatre ids provided — match theatre-admin audience (less safe)
      vis.push({ audience: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] } });
    }

    if (includeAll) vis.push({ audience: "ALL" });
    return vis;
  }

  // THEATER_USERS — similar to normal users but allow theatre-scoped user broadcasts
  if (r === "THEATER_USERS" || r === "THEATER_USER") {
    const ors = [
      { audience: "ALL" },
      { audience: "USER", user: new mongoose.Types.ObjectId(userId) },
    ];

    if (Array.isArray(userTheatreIds) && userTheatreIds.length > 0) {
      const tObjs = userTheatreIds
        .filter(Boolean)
        .map((t) =>
          mongoose.Types.ObjectId.isValid(String(t))
            ? new mongoose.Types.ObjectId(String(t))
            : null
        )
        .filter(Boolean);

      if (tObjs.length > 0) {
        ors.push({
          audience: "THEATER_USERS",
          $or: [
            { theatreId: { $in: tObjs } },
            { theaterId: { $in: tObjs } },
            { theatre: { $in: tObjs } },
            { theater: { $in: tObjs } },
          ],
        });
      }
    }

    vis.push({ $or: ors });
    return vis;
  }

  // Regular USER: user-specific + global
  vis.push({
    $or: [{ audience: "ALL" }, { audience: "USER", user: new mongoose.Types.ObjectId(userId) }],
  });

  return vis;
}

function unreadCond(readerId) {
  return {
    $and: [
      {
        $or: [{ readBy: { $exists: false } }, { readBy: { $nin: [readerId] } }],
      },
      {
        $or: [{ readAt: { $exists: false } }, { readAt: null }],
      },
    ],
  };
}

/**
 * Check whether a user (given role, userId and their theatre ids) can see a notification doc.
 */
function canSeeNotification({ doc, role, userId, userTheatreIds = [] }) {
  if (!doc) return false;
  const r = normRole(role);
  const aud = String(doc.audience || "").toUpperCase();

  if (aud === "ALL") return true;

  if (aud === "ADMIN") {
    return r === "SUPER_ADMIN";
  }

  if (aud === "THEATER_ADMIN" || aud === "THEATRE_ADMIN") {
    if (r === "SUPER_ADMIN") return true;

    if (r === "THEATRE_ADMIN" || r === "THEATER_ADMIN") {
      if (doc.user) {
        return String(doc.user) === String(userId);
      }

      const docTheatreIds = [
        doc.theatreId,
        doc.theaterId,
        doc.theatre,
        doc.theater,
      ]
        .filter(Boolean)
        .map(String);

      if (docTheatreIds.length > 0) {
        return userTheatreIds.map(String).some((ut) =>
          docTheatreIds.includes(String(ut))
        );
      }

      return true;
    }

    return false;
  }

  if (aud === "USER" || aud === "" || aud === "NULL") {
    return String(doc.user || "") === String(userId);
  }

  return false;
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

router.get("/ping", requireAuth(), (req, res) => {
  return res.json({
    ok: true,
    userId: req.user?._id,
    role: req.user?.role,
  });
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
  const ru = normRole(role);
  const isSuperAdmin = ru === "SUPER_ADMIN";

  const channel = isSuperAdmin && scope === "admin" ? "admin" : String(userId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.write("retry: 10000\n\n");

  addClient(channel, res);
  res._sseWritable = () => !res.writableEnded && !res.destroyed;

  sseWrite(res, {
    event: "connected",
    data: { channel, role, ts: Date.now() },
  });

  const hb = setInterval(() => heartbeat(res), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(hb);
    removeClient(channel, res);
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
  for (const [_, set] of clients.entries()) {
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
function prefKeyForType(type) {
  const t = String(type || "").toUpperCase();
  if (t.includes("CONFIRMED")) return "bookingConfirmed";
  if (t.includes("CANCELLED")) return "bookingCancelled";
  if (t.includes("REMINDER")) return "bookingReminder";
  if (t.includes("SHOWTIME")) return "showtimeChanged";
  if (t.includes("UPCOMING")) return "upcomingMovie";
  return null;
}

export async function pushNotification(doc) {
  if (!doc) return 0;
  const payload = doc.toObject ? doc.toObject() : doc;
  let delivered = 0;

  try {
    switch (payload.audience) {
      case "ADMIN":
        delivered += broadcastToAdmins(payload);
        break;

      case "THEATER_ADMIN":
      case "THEATRE_ADMIN":
        if (payload.user) {
          delivered += broadcastToUser(String(payload.user), payload);
        } else if (payload.theatreId) {
          try {
            const tId =
              typeof payload.theatreId === "string"
                ? payload.theatreId
                : payload.theatreId?._id || payload.theatreId;
            const candidateQuery = {
              role: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] },
              $or: [
                { theatre: tId },
                { theatreId: tId },
                { theater: tId },
                { theaterId: tId },
              ],
            };
            const admins = await User.find(candidateQuery).select("_id").lean();
            if (Array.isArray(admins) && admins.length) {
              for (const a of admins) {
                delivered += broadcastToUser(String(a._id), payload);
              }
            }
          } catch (err) {
            console.warn("[pushNotification] theatreId -> admin lookup failed:", err?.message || err);
          }
        }
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

  /* ---------------------------------------------------------------------- */
  /*                            EMAIL SENDING                               */
  /* ---------------------------------------------------------------------- */
  try {
    const wantsEmail = Array.isArray(payload.channels) && payload.channels.includes("EMAIL");
    if (!wantsEmail) return delivered;

    let to = null;
    if (payload.email) to = payload.email;
    else if (payload.user && payload.user.email) to = payload.user.email;

    const prefKey = prefKeyForType(payload.type);

    if (payload.audience === "USER" && payload.user) {
      const userId =
        typeof payload.user === "object" && payload.user._id
          ? String(payload.user._id)
          : String(payload.user);

      const [pref, userDoc] = await Promise.all([    
        NotificationPref.findOne({ user: userId }).lean(),
        !to
          ? mongoose.model("User").findById(userId).select("email name").lean()
          : Promise.resolve(null),
      ]);

      const allowEmail = prefKey ? Boolean(pref?.[prefKey]?.email) : true;
      if (!allowEmail) return delivered;
      if (!to && userDoc?.email) to = userDoc.email;
    }

    if (!to) return delivered;

    const subject = payload.title || payload.type || "Notification";
    const html =
      payload.html ||
      renderTemplate?.("booking-confirmed", {
        name: payload.user?.name || "Customer",
        movieTitle: payload.data?.movieTitle || "",
        showtime: payload.data?.showtime || "",
        seats: payload.data?.seats || "",
        bookingId: payload.data?.bookingId || "",
        ticketViewUrl: payload.data?.ticketViewUrl || "#",
        ticketPdfUrl: payload.data?.ticketPdfUrl || "#",
      }) ||
      `<h3>${subject}</h3><p>${payload.message || ""}</p>`;

    const mailRes = await mailer.sendEmail({
      to,
      subject,
      html,
      text: payload.message || undefined,
    });
    if (!mailRes?.ok) {
      console.error("[pushNotification] Email failed:", mailRes?.error || "unknown");
    } else {
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
    console.error("[notifications] /notify error:", err?.stack || err);
    return res.status(500).json({ delivered: 0 });
  }
});

/* -------------------------------------------------------------------------- */
/*                           LIST / COUNT / READ                              */
/* -------------------------------------------------------------------------- */

/**
 * Defensive listMine: logs inputs, validates theatreId, avoids populates,
 * and returns lean() documents. This should avoid 500s caused by bad IDs or populate/ref issues.
 */
async function listMine(req, res) {
  try {
    if (!req.user) {
      console.warn("[notifications] listMine unauthenticated request");
      return res.status(401).json({ ok: false, items: [] });
    }

    console.log("[notifications] listMine request - user:", req.user?._id, "role:", req.user?.role, "query:", req.query);

    const role = req.user.role;
    const userId = String(req.user._id);
    const ru = normRole(role);
    const isSuperAdmin = ru === "SUPER_ADMIN";
    const readerId = isSuperAdmin ? "admin" : userId;

    const unreadFlag = String(req.query.unread || "") === "1";
    const rawLimit = req.query.limit || "50";
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 100);

    // derive user's theatre ids (handle legacy fields)
    const userTheatreIds = [
      req.user?.theatre?._id,
      req.user?.theatreId,
      req.user?.theater?._id,
      req.user?.theaterId,
    ].filter(Boolean);

    // build visibility using the user's theatre ids
    const visArray = visibilityOr({ role, userId, includeAll: true, userTheatreIds });
    if (!Array.isArray(visArray) || visArray.length === 0) {
      console.warn("[notifications] visibilityOr returned empty, defaulting to user-only visibility");
    }

    const q = { $or: Array.isArray(visArray) && visArray.length ? [...visArray] : [{ user: new mongoose.Types.ObjectId(userId) }] };

    // optional admin query param: allow theatre-admin to filter by a specific theatreId (validate)
    if ((ru === "THEATRE_ADMIN" || ru === "THEATER_ADMIN") && req.query?.theatreId) {
      const tid = req.query.theatreId;
      if (mongoose.Types.ObjectId.isValid(tid)) {
        const tObj = new mongoose.Types.ObjectId(tid);
        q.$or.push({
          $and: [
            { audience: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] } },
            {
              $or: [
                { theatreId: tObj },
                { theaterId: tObj },
                { theatre: tObj },
                { theater: tObj },
              ],
            },
          ],
        });
      } else {
        console.warn("[notifications] listMine: ignored invalid theatreId:", tid);
      }
    }

    if (unreadFlag) {
      q.$and = q.$and || [];
      q.$and.push(unreadCond(readerId));
    }

    console.log("[notifications] listMine final query:", JSON.stringify(q));

    const items = await Notification.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("[notifications] listMine error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, items: [], error: err?.message || "internal" });
  }
}

router.get("/mine", requireAuth(), listMine);
router.get("/me", requireAuth(), listMine);

router.get("/unread-count", requireAuth(), async (req, res) => {
  try {
    const role = req.user.role;
    const userId = String(req.user._id);
    const ru = normRole(role);
    const isSuperAdmin = ru === "SUPER_ADMIN";
    const readerId = isSuperAdmin ? "admin" : userId;

    const userTheatreIds = [
      req.user?.theatre?._id,
      req.user?.theatreId,
      req.user?.theater?._id,
      req.user?.theaterId,
    ].filter(Boolean);

    const count = await Notification.countDocuments({
      $and: [{ $or: visibilityOr({ role, userId, includeAll: true, userTheatreIds }) }, unreadCond(readerId)],
    });

    return res.json({ ok: true, count });
  } catch (err) {
    console.error("[notifications] count error:", err?.stack || err);
    return res.status(500).json({ ok: false, count: 0 });
  }
});

router.patch("/:id/read", requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

    const role = req.user.role;
    const userId = String(req.user._id);
    const ru = normRole(role);
    const isSuperAdmin = ru === "SUPER_ADMIN";
    const readerId = isSuperAdmin ? "admin" : userId;

    const doc = await Notification.findById(id);
    const userTheatreIds = [req.user?.theatre?._id, req.user?.theatreId, req.user?.theater?._id, req.user?.theaterId].filter(Boolean);

    if (!doc || !canSeeNotification({ doc, role, userId, userTheatreIds }))
      return res.status(404).json({ message: "Not found" });

    const update = { $addToSet: { readBy: readerId } };

    const isUserNote =
      ru !== "SUPER_ADMIN" &&
      String(doc.user || "") === userId &&
      (doc.audience === "USER" || doc.audience == null);
    if (isUserNote && !doc.readAt) update.$set = { readAt: new Date() };

    const updated = await Notification.findByIdAndUpdate(id, update, { new: true });

    return res.json({ ok: true, notification: updated });
  } catch (err) {
    console.error("[notifications] read error:", err?.stack || err);
    return res.status(500).json({ message: "Failed to mark read" });
  }
});

router.post("/read-all", requireAuth(), async (req, res) => {
  try {
    const role = req.user.role;
    const userId = String(req.user._id);
    const ru = normRole(role);
    const isSuperAdmin = ru === "SUPER_ADMIN";
    const readerId = isSuperAdmin ? "admin" : userId;

    const userTheatreIds = [
      req.user?.theatre?._id,
      req.user?.theatreId,
      req.user?.theater?._id,
      req.user?.theaterId,
    ].filter(Boolean);

    const vis = visibilityOr({ role, userId, includeAll: true, userTheatreIds });

    const update = { $addToSet: { readBy: readerId } };
    if (!isSuperAdmin) update.$set = { readAt: new Date() };

    const result = await Notification.updateMany({ $or: vis }, update);

    return res.json({ ok: true, modified: result.modifiedCount });
  } catch (err) {
    console.error("[notifications] read-all error:", err?.stack || err);
    return res.status(500).json({ ok: false, modified: 0 });
  }
});

/* -------------------------------------------------------------------------- */
/*                           DETAILS / OPEN                                   */
/* -------------------------------------------------------------------------- */
router.get("/:id", requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

    const role = req.user.role;
    const userId = String(req.user._id);
    const userTheatreIds = [req.user?.theatre?._id, req.user?.theatreId, req.user?.theater?._id, req.user?.theaterId].filter(Boolean);

    const doc = await Notification.findById(id).lean();
    if (!doc || !canSeeNotification({ doc, role, userId, userTheatreIds })) return res.status(404).json({ message: "Not found" });

    return res.json({ ok: true, notification: doc });
  } catch (err) {
    console.error("[notifications] detail error:", err?.stack || err);
    return res.status(500).json({ message: "Failed to load" });
  }
});

router.post("/:id/open", requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

    const role = req.user.role;
    const userId = String(req.user._id);
    const ru = normRole(role);
    const isSuperAdmin = ru === "SUPER_ADMIN";
    const readerId = isSuperAdmin ? "admin" : userId;
    const userTheatreIds = [req.user?.theatre?._id, req.user?.theatreId, req.user?.theater?._id, req.user?.theaterId].filter(Boolean);

    const doc = await Notification.findById(id);
    if (!doc || !canSeeNotification({ doc, role, userId, userTheatreIds })) return res.status(404).json({ message: "Not found" });

    const update = { $addToSet: { readBy: readerId } };

    const isUserNote =
      ru !== "SUPER_ADMIN" &&
      String(doc.user || "") === userId &&
      (doc.audience === "USER" || doc.audience == null);
    if (isUserNote && !doc.readAt) update.$set = { readAt: new Date() };

    const updated = await Notification.findByIdAndUpdate(id, update, { new: true }).lean();

    return res.json({ ok: true, notification: updated });
  } catch (err) {
    console.error("[notifications] open error:", err?.stack || err);
    return res.status(500).json({ message: "Failed to open" });
  }
});

export default router;
