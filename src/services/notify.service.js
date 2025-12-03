// src/services/notify.service.js
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import NotificationPref from "../models/NotificationPref.js";
import { pushToUser } from "../socket/sse.js"; // <-- your SSE helper
import nodemailer from "nodemailer";

/* ------------------------------------------------------------------ */
/*  Transport: singleton Nodemailer (use Gmail App Password)          */
/* ------------------------------------------------------------------ */
let mailer;
function getMailer() {
  if (mailer) return mailer;
  const { EMAIL_USER, EMAIL_PASS, SMTP_HOST, SMTP_PORT } = process.env;

  if (SMTP_HOST) {
    // Generic SMTP (recommended for prod)
    mailer = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT ?? 587),
      secure: false,
      auth: EMAIL_USER && EMAIL_PASS ? { user: EMAIL_USER, pass: EMAIL_PASS } : undefined,
    });
  } else {
    // Gmail fallback (needs app password)
    mailer = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });
  }
  return mailer;
}

/* ------------------------------------------------------------------ */
/*  Channel senders                                                   */
/* ------------------------------------------------------------------ */
async function sendInApp(userId, notifDoc) {
  // push only to this user’s open SSE connections
  try {
    pushToUser?.(String(userId), { type: "NOTIFICATION", payload: notifDoc });
  } catch (e) {
    console.warn("IN_APP pushToUser failed:", e?.message);
  }
}

async function sendEmail(userId, subject, text) {
  const user = await User.findById(userId).select("email name").lean();
  if (!user?.email) return { ok: false, reason: "no-email" };

  const transporter = getMailer();
  if (!transporter) return { ok: false, reason: "no-transporter" };

  const mail = {
    from: `"Cinema App" <${process.env.EMAIL_USER || "no-reply@cinema.app"}>`,
    to: user.email,
    subject,
    text,
    // simple HTML mirror (optional)
    html: `<p>${text.replace(/\n/g, "<br/>")}</p>`,
  };

  await transporter.sendMail(mail);
  return { ok: true };
}

async function sendSMS(userId, message) {
  const user = await User.findById(userId).select("phone").lean();
  if (!user?.phone) return { ok: false, reason: "no-phone" };
  // TODO: Twilio
  console.log(`📱 SMS → ${user.phone}\n${message}`);
  return { ok: true };
}

async function sendPush(userId, title, body, data) {
  // TODO: FCM/WebPush
  console.log(`🔔 PUSH → user:${userId}\n${title} — ${body}`);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Dispatcher: honors user prefs, stores Notification, fans out      */
/* ------------------------------------------------------------------ */
export async function dispatchNotification(
  userId,
  { type, title, message, data = {} }
) {
  if (!userId || !type || !title || !message)
    throw new Error("dispatchNotification: missing userId/type/title/message");

  // Read preferences
  const prefs = await NotificationPref.findOne({ user: userId }).lean();
  const prefKeyMap = {
    BOOKING_CONFIRMED: "bookingConfirmed",
    BOOKING_CANCELLED: "bookingCancelled",
    BOOKING_REMINDER:  "bookingReminder",
    SHOWTIME_CHANGED:  "showtimeChanged",
    UPCOMING_MOVIE:    "upcomingMovie",
  };
  const chosen = prefs?.[prefKeyMap[type]];

  const channels = [];
  const fallback = { inApp: true, email: true, sms: false, push: false };
  const effective = chosen || fallback;

  if (effective.inApp) channels.push("IN_APP");
  if (effective.email) channels.push("EMAIL");
  if (effective.sms)   channels.push("SMS");
  if (effective.push)  channels.push("PUSH");

  // Save the notification
  const notif = await Notification.create({
    user: userId,
    type,
    title,
    message,
    data,
    channels,
    sentAt: new Date(),
  });

  // Fan out (best-effort), collect results
  const results = {};
  for (const ch of channels) {
    try {
      if (ch === "IN_APP") { await sendInApp(userId, notif); results.IN_APP = true; }
      else if (ch === "EMAIL") { results.EMAIL = (await sendEmail(userId, title, message)).ok; }
      else if (ch === "SMS") { results.SMS = (await sendSMS(userId, message)).ok; }
      else if (ch === "PUSH") { results.PUSH = (await sendPush(userId, title, message, data)).ok; }
    } catch (e) {
      results[ch] = false;
      console.warn(`⚠️ ${ch} delivery failed for ${type}:`, e?.message);
    }
  }

  return { notif, results };
}
