// jobs/agenda.js
import Agenda from "agenda";
import mongoose from "mongoose";
import Notification from "../models/Notification.js";
import NotificationPref from "../models/NotificationPref.js";
import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import Movie from "../models/Movie.js";
import { sendInApp, sendEmail, sendSMS, sendPush } from "../services/notify.service.js";

/* ───────────────────────── Config & Initialization ───────────────────────── */

const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/app";
export const agenda = new Agenda({
  db: { address: mongoUrl, collection: "jobs", options: { useUnifiedTopology: true } },
  processEvery: "1 minute",
  defaultConcurrency: 20,
});

/* ────────────────────────────── Small Utilities ──────────────────────────── */

function fmtDate(dt, tz = "Asia/Kolkata") {
  try {
    return new Date(dt).toLocaleString("en-IN", { timeZone: tz });
  } catch {
    return new Date(dt).toLocaleString();
  }
}

async function getUserTz(userId) {
  const pref = await NotificationPref.findOne({ user: userId })
    .select("timezone")
    .lean();
  return pref?.timezone || "Asia/Kolkata";
}

/**
 * Deliver a notification honoring user preferences for the type.
 * Creates a Notification doc and fan-outs to enabled channels.
 */
async function deliver(userId, type, title, message, payload = {}) {
  const prefDoc = await NotificationPref.findOne({ user: userId }).lean();

  const pMap = {
    BOOKING_REMINDER:  prefDoc?.bookingReminder,
    SHOWTIME_CHANGED:  prefDoc?.showtimeChanged,
    UPCOMING_MOVIE:    prefDoc?.upcomingMovie,
    BOOKING_CONFIRMED: prefDoc?.bookingConfirmed, // not used by Agenda, but handy
    BOOKING_CANCELLED: prefDoc?.bookingCancelled, // not used by Agenda, but handy
  };

  const p = pMap[type] || { inApp: true, email: true, sms: false, push: false };

  const channels = [];
  if (p.inApp) channels.push("IN_APP");
  if (p.email) channels.push("EMAIL");
  if (p.sms)   channels.push("SMS");
  if (p.push)  channels.push("PUSH");

  const notif = await Notification.create({
    user: userId,
    type,
    title,
    message,
    data: payload,
    channels,
    sentAt: new Date(),
  });

  // Fire each channel; let failures in one channel not block others.
  const tasks = [];
  if (p.inApp) tasks.push(sendInApp(userId, notif).catch(() => {}));
  if (p.email) tasks.push(sendEmail(userId, title, message, payload).catch(() => {}));
  if (p.sms)   tasks.push(sendSMS(userId, message).catch(() => {}));
  if (p.push)  tasks.push(sendPush(userId, title, message, payload).catch(() => {}));
  await Promise.allSettled(tasks);

  return notif;
}

/* ───────────────────────────────── Define Jobs ───────────────────────────── */

/**
 * Job: booking.reminder
 * Data: { bookingId: ObjectId, whenLabel: "2h_before" | ... }
 */
agenda.define("booking.reminder", async (job) => {
  const { bookingId, whenLabel } = job.attrs.data || {};
  if (!bookingId) return;

  const booking = await Booking.findById(bookingId)
    .populate("user showtime movie")
    .lean();
  if (!booking) return;

  const start =
    booking.startTime ||
    booking.showtime?.startTime ||
    (await Showtime.findById(booking.showtime).select("startTime").lean())?.startTime;

  if (!start) return;

  const tz = await getUserTz(booking.user);
  const title = "Your movie is coming up 🍿";
  const message = `Reminder: ${booking.movie?.title ?? "Your movie"} at ${fmtDate(start, tz)}. Seats: ${booking.seats?.length || 1}.`;

  await deliver(
    booking.user,
    "BOOKING_REMINDER",
    title,
    message,
    { bookingId: booking._id, showtimeId: booking.showtime?._id || booking.showtime, when: whenLabel }
  );
});

/**
 * Job: showtime.changed
 * Data: { showtimeId, before, after? }   (after falls back to current DB value)
 * Sends to all users who have a booking for the showtime.
 */
agenda.define("showtime.changed", async (job) => {
  const { showtimeId, before, after } = job.attrs.data || {};
  if (!showtimeId) return;

  const st = await Showtime.findById(showtimeId).populate("movie").lean();
  if (!st) return;

  const affected = await Booking.find({ showtime: showtimeId })
    .select("user _id seats")
    .lean();

  await Promise.allSettled(
    affected.map(async (b) => {
      const tz = await getUserTz(b.user);
      const fromStr = before ? fmtDate(before, tz) : "previous time";
      const toStr = fmtDate(after ?? st.startTime, tz);
      return deliver(
        b.user,
        "SHOWTIME_CHANGED",
        "Showtime updated",
        `The showtime for ${st.movie?.title ?? "your booking"} changed from ${fromStr} to ${toStr}.`,
        { bookingId: b._id, showtimeId, before, after: after ?? st.startTime }
      );
    })
  );
});

/**
 * Job: movie.upcoming.digest
 * Weekly digest of movies releasing within the next 7 days.
 * Broadcasts to users who enabled upcomingMovie notifications.
 */
agenda.define("movie.upcoming.digest", async () => {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 7);

  const movies = await Movie.find({
    releaseDate: { $gte: from, $lte: to },
    status: { $ne: "RELEASED" },
  })
    .select("_id title releaseDate")
    .limit(20)
    .lean();

  if (!movies.length) return;

  const prefs = await NotificationPref.find({
    $or: [{ "upcomingMovie.inApp": true }, { "upcomingMovie.email": true }],
  })
    .select("user upcomingMovie timezone")
    .lean();

  const lines = movies.map((m) => `• ${m.title} — ${new Date(m.releaseDate).toDateString()}`);
  const text = lines.join("\n");

  await Promise.allSettled(
    prefs.map((p) =>
      deliver(
        p.user,
        "UPCOMING_MOVIE",
        "🎞️ Upcoming movies this week",
        text,
        { movieIds: movies.map((m) => m._id) }
      )
    )
  );
});

/* ───────────────────────────── Scheduling Helpers ────────────────────────── */

/**
 * Schedule a reminder ~2 hours before showtime.
 * Ensures only one reminder per booking via unique query.
 */
export async function scheduleBookingReminder(booking) {
  const start =
    booking.startTime ||
    (await Showtime.findById(booking.showtime).select("startTime").lean())?.startTime;
  if (!start) return;

  const when = new Date(new Date(start).getTime() - 2 * 60 * 60 * 1000);
  await agenda.schedule(
    when,
    "booking.reminder",
    { bookingId: booking._id, whenLabel: "2h_before" },
    { unique: { name: "booking.reminder", "data.bookingId": booking._id } }
  );
}

/** Cancel a scheduled reminder for a booking. */
export async function cancelBookingReminder(bookingId) {
  await agenda.cancel({ name: "booking.reminder", "data.bookingId": bookingId });
}

/**
 * When a showtime time changes, enqueue a change-notification job.
 * Controllers can call this after updating the showtime.
 */
export async function scheduleShowtimeChanged(showtimeId, before, after) {
  await agenda.now("showtime.changed", { showtimeId, before, after });
}

/* ─────────────────────────── Bootstrapping Lifecycle ─────────────────────── */

export async function startAgenda() {
  // Optional: share existing mongoose connection pool if already connected.
  // if (mongoose.connection?.db) agenda.mongo(mongoose.connection.db, "jobs");

  await agenda.start();

  // Weekly digest: Monday 9:00 AM IST, ensure uniqueness
  await agenda.every("0 9 * * 1", "movie.upcoming.digest", {}, {
    timezone: "Asia/Kolkata",
    unique: { name: "movie.upcoming.digest" },
    skipImmediate: true,
  });

  // Graceful shutdown
  const stop = async () => {
    try {
      await agenda.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // Logging (optional)
  console.log("✅ Agenda started");
}

export async function stopAgenda() {
  await agenda.stop();
  console.log("🛑 Agenda stopped");
}
