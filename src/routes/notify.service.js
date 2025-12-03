// backend/src/services/notify.service.js
// Reworked notify service — uses your mailer wrapper and ties into SSE helper
import mongoose from "mongoose";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import NotificationPref from "../models/NotificationPref.js";
import { pushToUser } from "../socket/sse.js"; // your SSE helper (best-effort)
import mailer from "../models/mailer.js"; // uses same sendEmail + Ethereal fallback
import { broadcastToUser, broadcastToAdmins, broadcastAll } from "../routes/notifications.routes.js";

/**
 * Helpers
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

async function sendInApp(userId, notifDoc) {
  try {
    // Try SSE helper first (if available)
    if (typeof pushToUser === "function") {
      try {
        await pushToUser(String(userId), { type: "NOTIFICATION", payload: notifDoc });
        return { ok: true };
      } catch (e) {
        console.warn("[notify] pushToUser failed:", e?.message || e);
      }
    }
    // Fallback: try broadcastToUser if exported from notifications.routes (best-effort)
    try {
      const delivered = typeof broadcastToUser === "function" ? broadcastToUser(String(userId), notifDoc) : 0;
      return { ok: true, delivered: delivered || 0 };
    } catch (e) {
      // ignore
    }
    return { ok: false, reason: "no-sse" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendEmail(userIdOrEmail, subject, html, text) {
  try {
    let to = null;
    if (mongoose.Types.ObjectId.isValid(String(userIdOrEmail))) {
      const user = await User.findById(userIdOrEmail).select("email name").lean();
      if (!user?.email) return { ok: false, reason: "no-email" };
      to = user.email;
    } else {
      to = String(userIdOrEmail);
    }

    if (!to) return { ok: false, reason: "no-email" };

    const res = await mailer.sendEmail({
      to,
      subject,
      html,
      text,
    });

    if (!res?.ok) return { ok: false, error: res?.error || "sendEmail failed" };
    return { ok: true, messageId: res.messageId, previewUrl: res.previewUrl };
  } catch (e) {
    console.error("[notify] sendEmail error:", e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendSMS(userId, message) {
  try {
    const user = await User.findById(userId).select("phone").lean();
    if (!user?.phone) return { ok: false, reason: "no-phone" };
    // TODO: integrate Twilio; for now print and return ok
    console.log(`SMS -> ${user.phone}\n${message}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendPush(userId, title, body, data = {}) {
  // TODO: integrate FCM/web-push
  console.log(`PUSH -> ${userId} | ${title} — ${body}`);
  return { ok: true };
}

/* ------------------------------------------------------------------
   dispatchNotification
   - honors NotificationPref
   - saves Notification document
   - fans out to channels (IN_APP, EMAIL, SMS, PUSH)
   - returns { notif, results: { IN_APP:..., EMAIL:... } }
------------------------------------------------------------------ */
export async function dispatchNotification(targetUserIdOrAudience, options = {}) {
  /**
   * targetUserIdOrAudience:
   *  - if string "USER:<userId>" or ObjectId => treat as USER
   *  - if "ADMIN" or "ALL" => broadcast accordingly
   *
   * options: { type, title, message, data }
   */
  const { type, title, message, data = {}, channels: reqChannels } = options || {};
  if (!type || !title || !message) throw new Error("type,title,message required");

  const scope = String(targetUserIdOrAudience || "").toUpperCase();
  const isAudienceAdmin = scope === "ADMIN";
  const isAudienceAll = scope === "ALL";

  // Build notification doc
  const doc = {
    audience: isAudienceAdmin ? "ADMIN" : isAudienceAll ? "ALL" : "USER",
    user: !isAudienceAdmin && !isAudienceAll ? String(targetUserIdOrAudience) : null,
    type,
    title,
    message,
    data,
    channels: Array.isArray(reqChannels) ? reqChannels : [], // will be filled below if empty
    sentAt: new Date(),
  };

  // If USER audience, read prefs and decide channels (if reqChannels not provided)
  let effectiveChannels = doc.channels && doc.channels.length > 0 ? doc.channels.slice() : null;
  if (doc.audience === "USER" && doc.user) {
    const prefKey = prefKeyForType(type);
    const prefs = await NotificationPref.findOne({ user: doc.user }).lean();
    const chosen = prefKey && prefs ? prefs[prefKey] : null;
    const fallback = { inApp: true, email: true, sms: false, push: false };
    const eff = chosen || fallback;

    if (!effectiveChannels) {
      effectiveChannels = [];
      if (eff.inApp) effectiveChannels.push("IN_APP");
      if (eff.email) effectiveChannels.push("EMAIL");
      if (eff.sms) effectiveChannels.push("SMS");
      if (eff.push) effectiveChannels.push("PUSH");
    }
  } else {
    // ADMIN or ALL: default to IN_APP, and EMAIL if provided
    if (!effectiveChannels) effectiveChannels = ["IN_APP", "EMAIL"];
  }

  doc.channels = effectiveChannels;

  // Persist notification
  let notif;
  try {
    notif = await Notification.create(doc);
  } catch (e) {
    console.error("[notify] Failed to create Notification doc:", e);
    throw e;
  }

  // Fan-out: run channels in parallel (best-effort)
  const results = {};
  const tasks = effectiveChannels.map(async (ch) => {
    try {
      if (ch === "IN_APP") {
        const r = await sendInApp(notif.user || targetUserIdOrAudience, notif);
        results.IN_APP = r;
      } else if (ch === "EMAIL") {
        // prefer explicit email in payload.data.email or notif.email; fall back to user lookup
        const to = data?.email || notif?.email || notif.user || null;
        const r = await sendEmail(to, title, data?.html || `<p>${message}</p>`, message);
        results.EMAIL = r;
      } else if (ch === "SMS") {
        const r = await sendSMS(notif.user, message);
        results.SMS = r;
      } else if (ch === "PUSH") {
        const r = await sendPush(notif.user, title, message, data);
        results.PUSH = r;
      } else {
        results[ch] = { ok: false, reason: "unknown-channel" };
      }
    } catch (e) {
      console.warn(`[notify] channel ${ch} failed:`, e?.message || e);
      results[ch] = { ok: false, error: e?.message || String(e) };
    }
  });

  await Promise.all(tasks);

  // Additionally, broadcast to SSE registries for ADMIN/ALL if available
  try {
    if (doc.audience === "ADMIN") broadcastToAdmins?.(notif);
    else if (doc.audience === "ALL") broadcastAll?.(notif);
    else if (doc.audience === "USER" && notif.user) broadcastToUser?.(notif.user, notif);
  } catch (e) {
    // ignore
  }

  return { notif, results };
}

export default { dispatchNotification };
