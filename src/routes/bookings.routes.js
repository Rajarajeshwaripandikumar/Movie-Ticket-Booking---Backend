// backend/src/routes/bookings.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { generateTicketPdf } from "../utils/generateTicketPdf.js";

import Showtime from "../models/Showtime.js";
import Screen from "../models/Screen.js";
import Booking from "../models/Booking.js";
import Notification from "../models/Notification.js";
import SeatLock from "../models/SeatLock.js";

import { requireAuth } from "../middleware/auth.js";
import { pushNotification } from "./notifications.routes.js"; // emits event: "notification"
import { sendEmail, renderTemplate } from "../models/mailer.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                                  Config                                    */
/* -------------------------------------------------------------------------- */

const APP_PUBLIC_BASE = process.env.APP_PUBLIC_BASE || process.env.APP_BASE_URL || "http://localhost:5173";
const BACKEND_PUBLIC_BASE = process.env.BACKEND_PUBLIC_BASE || `http://localhost:${process.env.PORT || 8080}`;
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
const SEAT_LOCK_TTL_MS = Number(process.env.SEAT_LOCK_TTL_MS || 2 * 60 * 1000); // 2 minutes default

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a canonical key for seat lookup.
 * Supports two modes:
 *  - seatId string keys (preferred): "A1"
 *  - numeric grid keys: "r:c" where r and c are numbers (e.g. "1:4")
 */
const seatKeyFrom = (seat) => {
  if (!seat) return null;
  if (seat.seatId) return String(seat.seatId);
  if (seat.row !== undefined && seat.col !== undefined) return `${Number(seat.row)}:${Number(seat.col)}`;
  return null;
};

/**
 * For showtime seat snapshot, derive the canonical key for each seat object.
 * If `seatId` exists, use that. Otherwise fallback to `row:col`.
 */
const seatKeyForSnapshot = (s) => {
  if (!s) return null;
  if (s.seatId) return String(s.seatId);
  if (s.row !== undefined && s.col !== undefined) return `${Number(s.row)}:${Number(s.col)}`;
  return null;
};

const fmtTime = (d) => new Date(d).toLocaleString("en-IN", { timeZone: TIMEZONE });

const pickUserEmail = (reqUser, bookingUser) => bookingUser?.email || reqUser?.email || null;
const pickUserName = (reqUser, bookingUser) =>
  bookingUser?.name ||
  reqUser?.name ||
  (pickUserEmail(reqUser, bookingUser)?.split("@")[0]) ||
  "there";

/* -------------------------------------------------------------------------- */
/*                   Ensure showtime has seat snapshot & reconcile locks      */
/* -------------------------------------------------------------------------- */

async function ensureSeatsInitialized(show) {
  if (Array.isArray(show.seats) && show.seats.length > 0) return show;
  // fallback to screen rows/cols
  const screen = await Screen.findById(show.screen).lean();
  const rows = Number(screen?.rows || 10);
  const cols = Number(screen?.cols || 10);

  const seats = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      seats.push({ row: r, col: c, status: "AVAILABLE" });
    }
  }
  show.seats = seats;
  await show.save();
  return show;
}

/**
 * Removes expired locks and updates show.seats status for any currently held locks.
 * This function is conservative — it doesn't override BOOKED seats.
 */
async function reconcileLocks(show) {
  const now = new Date();

  // remove expired locks (TTL index will also run)
  await SeatLock.deleteMany({
    showtime: show._id,
    status: "HELD",
    lockedUntil: { $lte: now },
  });

  const activeLocks = await SeatLock.find({
    showtime: show._id,
    status: "HELD",
    lockedUntil: { $gt: now },
  }).select("seat").lean();

  const lockedSet = new Set(activeLocks.map((l) => String(l.seat)));
  let dirty = false;

  for (let i = 0; i < show.seats.length; i++) {
    const s = show.seats[i];
    const k = seatKeyForSnapshot(s);
    if (!k) continue;

    if (lockedSet.has(k)) {
      if (s.status !== "BOOKED" && s.status !== "LOCKED") {
        show.seats[i].status = "LOCKED";
        dirty = true;
      }
    } else {
      if (s.status === "LOCKED") {
        show.seats[i].status = "AVAILABLE";
        dirty = true;
      }
    }
  }
  if (dirty) await show.save();
}

/* -------------------------------------------------------------------------- */
/*                               seat utilities                               */
/* -------------------------------------------------------------------------- */

function normalizeRequestedSeats(seats = []) {
  // Accept either array of {seatId} or {row,col} or mixed.
  const out = [];
  for (const s of seats) {
    if (!s) continue;
    if (s.seatId) out.push({ seatId: String(s.seatId) });
    else if (s.row !== undefined && s.col !== undefined) out.push({ row: Number(s.row), col: Number(s.col) });
  }
  // dedupe by canonical key
  const m = new Map();
  for (const s of out) {
    const k = seatKeyFrom(s);
    if (k) m.set(k, s);
  }
  return Array.from(m.values());
}

/* -------------------------------------------------------------------------- */
/*                             free seats helper                              */
/* -------------------------------------------------------------------------- */

async function freeSeatsForBooking(booking) {
  try {
    const show = await Showtime.findById(booking.showtime);
    if (!show) {
      console.error("[freeSeatsForBooking] showtime not found for booking", String(booking._id));
      return;
    }
    await ensureSeatsInitialized(show);

    const index = new Map(show.seats.map((s, i) => [seatKeyForSnapshot(s), i]));
    for (const s of booking.seats || []) {
      const k = seatKeyFrom(s);
      const i = index.get(k);
      if (i !== undefined) show.seats[i].status = "AVAILABLE";
    }
    await show.save();

    await SeatLock.deleteMany({
      showtime: booking.showtime,
      lockedBy: booking.user,
      status: "HELD",
    });
  } catch (err) {
    console.error("freeSeatsForBooking failed:", err);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   ROUTES                                   */
/* -------------------------------------------------------------------------- */

/** 🔒 LOCK seats */
router.post("/lock", requireAuth, async (req, res) => {
  const tag = "[POST /bookings/lock]";
  try {
    const { showtimeId } = req.body || {};
    let seats = normalizeRequestedSeats(req.body?.seats || []);

    if (!mongoose.isValidObjectId(showtimeId)) return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    if (!seats.length) return res.status(400).json({ ok: false, error: "seats array is required" });

    let show = await Showtime.findById(showtimeId);
    if (!show) return res.status(404).json({ ok: false, error: "Showtime not found" });

    await ensureSeatsInitialized(show);
    await reconcileLocks(show);

    // Build index from snapshot using canonical keys
    const idx = new Map(show.seats.map((s, i) => [seatKeyForSnapshot(s), i]));
    const toLockKeys = seats.map((s) => seatKeyFrom(s));

    // detect unavailable seats
    const unavailable = [];
    for (const s of seats) {
      const key = seatKeyFrom(s);
      const i = idx.get(key);
      const st = i === undefined ? "MISSING" : show.seats[i].status;
      if (i === undefined || st !== "AVAILABLE") {
        unavailable.push({ ...s, current: st });
      }
    }
    if (unavailable.length) {
      return res.status(409).json({ ok: false, error: "Some seats unavailable", details: { unavailable } });
    }

    const lockedUntil = new Date(Date.now() + SEAT_LOCK_TTL_MS);

    // Bulk insert locks; unique index on (showtime, seat) prevents races
    try {
      await SeatLock.bulkWrite(
        toLockKeys.map((key) => ({
          insertOne: {
            document: {
              showtime: show._id,
              seat: key,
              lockedBy: req.user?.id || req.user?._id,
              lockedUntil,
              status: "HELD",
            },
          },
        })),
        { ordered: true }
      );
    } catch (err) {
      // Duplicate key means someone else locked concurrently
      if (err?.code === 11000) {
        return res.status(409).json({
          ok: false,
          error: "Some seats just got locked by another user",
          code: "DUPLICATE_LOCK",
        });
      }
      console.error(tag, "bulkWrite error:", err);
      throw err;
    }

    // Update show snapshot to LOCKED for these seats
    for (const key of toLockKeys) {
      const i = idx.get(key);
      if (i !== undefined) show.seats[i].status = "LOCKED";
    }
    await show.save();

    console.log(tag, "ok", {
      user: String(req.user?.id || req.user?._id),
      showtime: String(show._id),
      seats: toLockKeys,
      lockedUntil: lockedUntil.toISOString(),
    });

    return res.json({
      ok: true,
      message: "Seats locked",
      seats,
      lockedUntil,
      serverTime: new Date(),
    });
  } catch (err) {
    console.error(tag, "Lock error:", err);
    return res.status(500).json({ ok: false, error: "Failed to lock seats" });
  }
});

/** 🔓 RELEASE seats held by requester */
router.post("/release", requireAuth, async (req, res) => {
  const tag = "[POST /bookings/release]";
  try {
    const { showtimeId } = req.body || {};
    let seats = normalizeRequestedSeats(req.body?.seats || []);

    if (!mongoose.isValidObjectId(showtimeId)) return res.status(400).json({ ok: false, error: "Invalid showtimeId" });

    const show = await Showtime.findById(showtimeId);
    if (!show) return res.status(404).json({ ok: false, error: "Showtime not found" });

    await ensureSeatsInitialized(show);

    const keys = seats.length ? seats.map((s) => seatKeyFrom(s)) : null;

    const filter = {
      showtime: showtimeId,
      lockedBy: req.user?.id || req.user?._id,
      status: "HELD",
    };
    if (keys) filter.seat = { $in: keys };

    const deleted = await SeatLock.deleteMany(filter);

    await reconcileLocks(show);

    return res.json({ ok: true, message: "Released", releasedCount: deleted.deletedCount || 0, seats: seats || [] });
  } catch (err) {
    console.error(tag, "Release error:", err);
    return res.status(500).json({ ok: false, error: "Failed to release seats" });
  }
});

/** ✅ CONFIRM booking (atomic transaction) */
router.post("/confirm", requireAuth, async (req, res) => {
  const tag = "[POST /bookings/confirm]";
  try {
    const idemKey = String(req.headers["x-idempotency-key"] || "").trim() || null;
    const { showtimeId } = req.body || {};
    let seats = normalizeRequestedSeats(req.body?.seats || []);
    const amountFromClient = req.body?.amount;

    if (!mongoose.isValidObjectId(showtimeId)) return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    if (!seats.length) return res.status(400).json({ ok: false, error: "seats array is required" });

    const userId = req.user?.id || req.user?._id;

    let show = await Showtime.findById(showtimeId).populate("movie");
    if (!show) return res.status(404).json({ ok: false, error: "Showtime not found" });

    await ensureSeatsInitialized(show);
    await reconcileLocks(show);

    // prepare canonical keys & index map from snapshot
    const idx = new Map(show.seats.map((s, i) => [seatKeyForSnapshot(s), i]));
    const keys = seats.map((s) => seatKeyFrom(s));

    // check known seats
    const missing = [];
    for (const k of keys) if (idx.get(k) === undefined) missing.push(k);
    if (missing.length) return res.status(400).json({ ok: false, error: "Unknown seats in snapshot", details: { missing } });

    // ensure all seats are locked by this user and still valid
    const now = new Date();
    const activeLocks = await SeatLock.find({
      showtime: show._id,
      lockedBy: userId,
      seat: { $in: keys },
      status: "HELD",
      lockedUntil: { $gt: now },
    }).select("seat").lean();

    if (activeLocks.length !== keys.length) {
      return res.status(409).json({ ok: false, error: "Seats already booked or lock expired" });
    }

    // idempotency: if a booking already exists with same idempotency key for this user/showtime -> return it
    if (idemKey) {
      const existing = await Booking.findOne({
        user: userId,
        showtime: show._id,
        "meta.idempotencyKey": idemKey,
      }).lean();
      if (existing) return res.status(200).json({ ok: true, message: "Already confirmed", booking: existing });
    }

    // transaction: mark seats BOOKED, create booking, mark locks USED
    let bookingDoc = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const showForWrite = await Showtime.findById(show._id).session(session);
        await ensureSeatsInitialized(showForWrite);
        await reconcileLocks(showForWrite);

        const localIdx = new Map(showForWrite.seats.map((s, i) => [seatKeyForSnapshot(s), i]));

        // verify statuses inside transaction and set to BOOKED
        for (const k of keys) {
          const i = localIdx.get(k);
          if (i === undefined) throw new Error(`Seat missing in snapshot: ${k}`);
          if (showForWrite.seats[i].status === "BOOKED") {
            const err = new Error(`Seat already booked: ${k}`);
            err.code = "ALREADY_BOOKED";
            throw err;
          }
          if (showForWrite.seats[i].status !== "LOCKED") {
            const err = new Error(`Seat not locked anymore: ${k}`);
            err.code = "LOCK_LOST";
            throw err;
          }
          showForWrite.seats[i].status = "BOOKED";
        }
        await showForWrite.save({ session });

        const finalAmount = Number(amountFromClient || seats.length * Number(show.basePrice || 200));

        const [booking] = await Booking.create(
          [
            {
              user: userId,
              showtime: show._id,
              seats: seats.map((s) => (s.seatId ? { seatId: s.seatId } : { row: s.row, col: s.col })),
              amount: finalAmount,
              status: "CONFIRMED",
              meta: { idempotencyKey: idemKey || null },
            },
          ],
          { session }
        );

        bookingDoc = booking;

        await SeatLock.updateMany(
          {
            showtime: show._id,
            lockedBy: userId,
            seat: { $in: keys },
            status: "HELD",
          },
          { $set: { status: "USED", usedAt: new Date() } },
          { session }
        );
      });
    } finally {
      session.endSession();
    }

    // Post-commit side-effects (async, non-blocking)
    (async () => {
      try {
        // Create USER notification + push
        const userNotif = await Notification.create({
          audience: "USER",
          user: userId,
          type: "BOOKING_CONFIRMED",
          title: "🎟️ Booking Confirmed",
          message: `Your booking for "${show.movie?.title || "a movie"}" on ${fmtTime(show.startTime)} has been confirmed.`,
          data: { bookingId: bookingDoc._id, showtimeId: show._id },
          channels: ["IN_APP", "EMAIL"],
        });
        try { pushNotification?.(userNotif); } catch (e) { console.warn("pushNotification user failed:", e?.message); }

        // Create ADMIN notification
        try {
          const adminNotif = await Notification.create({
            audience: "ADMIN",
            type: "BOOKING_CONFIRMED",
            title: "New booking",
            message: `Booking #${String(bookingDoc._id)} by ${req.user?.email || "user"}`,
            data: { bookingId: bookingDoc._id, userEmail: req.user?.email, showtimeId: show._id },
            channels: ["IN_APP"],
          });
          pushNotification?.(adminNotif);
        } catch (anErr) {
          console.warn("admin notification create failed:", anErr?.message);
        }

        // Prepare and send email (with optional PDF)
        const to = pickUserEmail(req.user, null);
        if (!to) {
          console.warn("No recipient email; skipping email send.");
        } else {
          const name = pickUserName(req.user, null);
          const seatsText = seats.map((s) => (s.seatId ? s.seatId : `${s.row}-${s.col}`)).join(", ");

          const linkToken = jwt.sign({ sub: String(userId), role: "USER" }, process.env.JWT_SECRET, { expiresIn: "24h" });

          const viewUrl = `${APP_PUBLIC_BASE}/bookings/${bookingDoc._id}?token=${encodeURIComponent(linkToken)}`;
          const pdfUrl = `${BACKEND_PUBLIC_BASE}/api/bookings/${bookingDoc._id}/pdf?token=${encodeURIComponent(linkToken)}`;

          const html =
            (renderTemplate && renderTemplate("booking-confirmed", {
              name,
              movieTitle: show.movie?.title || "your movie",
              showtime: fmtTime(show.startTime),
              seats: seatsText,
              bookingId: String(bookingDoc._id),
              ticketViewUrl: viewUrl,
              ticketPdfUrl: pdfUrl,
            })) || `<p>Your booking for ${show.movie?.title} is confirmed.</p>`;

          const attachments = [];
          try {
            const { buffer } = await generateTicketPdf(
              bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc,
              { name, email: to },
              show,
              { baseUrl: APP_PUBLIC_BASE }
            );
            if (buffer) {
              attachments.push({
                filename: `Ticket-${String(bookingDoc._id)}.pdf`,
                content: buffer,
                contentType: "application/pdf",
              });
            }
          } catch (pdfErr) {
            console.warn("Ticket PDF generation failed (email will still send):", pdfErr?.message);
          }

          const mailRes = await sendEmail({ to, subject: userNotif.title, html, attachments });
          if (!mailRes?.ok) console.error("Email failed:", mailRes?.error || "unknown");
          else console.log("Email sent:", mailRes.messageId, mailRes.previewUrl || "");
        }
      } catch (e) {
        console.warn("Notification/email post-commit failed:", e?.message || e);
      }
    })();

    return res.status(201).json({ ok: true, message: "Booking confirmed", booking: bookingDoc });
  } catch (err) {
    console.error("[Confirm booking] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to confirm booking",
      details: process.env.NODE_ENV === "development" ? { message: err?.message, code: err?.code } : undefined,
    });
  }
});

/** 🧾 USER's bookings */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const bookings = await Booking.find({ user: userId })
      .populate({
        path: "showtime",
        populate: [
          { path: "movie", select: "title posterUrl runtime" },
          { path: "screen", select: "name" },
        ],
      })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, bookings });
  } catch (err) {
    console.error("Fetch bookings error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch bookings" });
  }
});

/** 🧾 SINGLE booking details — accepts ?token=... */
router.get(
  "/:id",
  (req, _res, next) => {
    if (req.query?.token && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
    next();
  },
  requireAuth,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid booking id" });

      const booking = await Booking.findById(req.params.id)
        .populate({
          path: "showtime",
          populate: [
            { path: "movie", select: "title posterUrl runtime" },
            { path: "screen", select: "name" },
          ],
        })
        .populate({ path: "user", select: "name email" })
        .lean();

      if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

      const isAdmin = String(req.user?.role || "").toUpperCase().includes("ADMIN");
      const bookingUserId = String(booking.user?._id || booking.user);
      if (!isAdmin && bookingUserId !== String(req.user?.id || req.user?._id)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      res.json({ ok: true, booking });
    } catch (err) {
      console.error("Fetch booking error:", err);
      res.status(500).json({ ok: false, error: "Failed to fetch booking" });
    }
  }
);

/** ❌ CANCEL booking (DELETE) */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate({
      path: "showtime",
      populate: { path: "movie", select: "title" },
    });
    if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

    const userId = String(req.user?.id || req.user?._id);
    if (String(booking.user) !== userId) return res.status(403).json({ ok: false, error: "Forbidden" });

    if (booking.status === "CANCELLED") return res.status(200).json({ ok: true, message: "Already cancelled", bookingId: booking._id });

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    await booking.save();
    await freeSeatsForBooking(booking);

    // async notifications + email
    (async () => {
      try {
        const notif = await Notification.create({
          audience: "USER",
          user: booking.user,
          type: "BOOKING_CANCELLED",
          title: "❌ Booking Cancelled",
          message: `Your booking for "${booking.showtime?.movie?.title}" has been cancelled.`,
          data: { bookingId: booking._id },
          channels: ["IN_APP", "EMAIL"],
        });
        try { pushNotification?.(notif); } catch (e) {}

        // admin notification
        try {
          const adminNotif = await Notification.create({
            audience: "ADMIN",
            type: "BOOKING_CANCELLED",
            title: "Booking cancelled",
            message: `Booking #${String(booking._id)} cancelled by ${req.user?.email || "user"}`,
            data: { bookingId: booking._id, userEmail: req.user?.email },
            channels: ["IN_APP"],
          });
          pushNotification?.(adminNotif);
        } catch {}

        // email
        const to = pickUserEmail(req.user, booking.user);
        if (to) {
          const html =
            (renderTemplate && renderTemplate("booking-cancelled", {
              name: pickUserName(req.user, booking.user),
              movieTitle: booking.showtime?.movie?.title || "your movie",
              bookingId: String(booking._id),
              ticketViewUrl: `${APP_PUBLIC_BASE}/bookings/${booking._id}`,
            })) || `<p>${notif.message}</p>`;

          const mailRes = await sendEmail({ to, subject: notif.title, html });
          if (!mailRes?.ok) console.error("Email failed:", mailRes?.error || "unknown");
          else console.log("Email sent:", mailRes.messageId, mailRes.previewUrl || "");
        }
      } catch (e) {
        console.warn("Cancellation notification/email failed:", e?.message);
      }
    })();

    return res.json({ ok: true, message: "Booking cancelled", bookingId: booking._id });
  } catch (err) {
    console.error("Cancel booking (DELETE) error:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to cancel booking" });
  }
});

/** ❌ CANCEL (PATCH style) — identical to DELETE but kept for API parity */
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  // reuse delete logic for consistency
  try {
    const result = await router.handle({ ...req, method: "DELETE" }, res);
    return result;
  } catch (err) {
    console.error("[PATCH cancel] error:", err);
    return res.status(500).json({ ok: false, error: "Failed to cancel booking" });
  }
});

/** 🗓️ Calendar — user's bookings as calendar events */
router.get("/calendar", requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = start ? new Date(start) : new Date();
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 86400000);

    const userId = req.user?.id || req.user?._id;
    const bookings = await Booking.find({ user: userId })
      .populate({ path: "showtime", populate: { path: "movie", select: "title posterUrl" } })
      .lean();

    const events = bookings
      .map((b) => ({ id: b._id, title: b.showtime?.movie?.title || "Booking", start: b.showtime?.startTime, raw: b }))
      .filter((e) => {
        const t = new Date(e.start);
        return t >= startDate && t <= endDate;
      });

    res.json({ ok: true, events });
  } catch (err) {
    console.error("Calendar error:", err);
    res.status(500).json({ ok: false, error: "Failed to load calendar" });
  }
});

/** 🧾 PDF Ticket Generator — accepts ?token=..., requires auth */
router.get(
  "/:id/pdf",
  (req, _res, next) => {
    if (!req.headers.authorization && req.query?.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
    next();
  },
  requireAuth,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid booking id" });

      const booking = await Booking.findById(req.params.id)
        .populate({
          path: "showtime",
          populate: [
            { path: "movie", select: "title posterUrl runtime" },
            { path: "screen", select: "name" },
          ],
        })
        .populate({ path: "user", select: "name email" })
        .lean();

      if (!booking) return res.status(404).json({ ok: false, error: "Not found" });

      const isAdmin = String(req.user?.role || "").toUpperCase().includes("ADMIN");
      const bookingUserId = String(booking.user?._id || booking.user);
      if (!isAdmin && bookingUserId !== String(req.user?.id || req.user?._id)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const userForPdf = {
        name:
          booking.user?.name ||
          req.user?.name ||
          (req.user?.email ? req.user.email.split("@")[0] : null) ||
          "Customer",
        email: booking.user?.email || req.user?.email || undefined,
      };

      const { buffer } = await generateTicketPdf(booking, userForPdf, booking.showtime, { baseUrl: APP_PUBLIC_BASE });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=ticket-${booking._id}.pdf`);
      res.send(buffer);
    } catch (err) {
      console.error("PDF generation error:", err);
      res.status(500).json({ ok: false, error: "Failed to generate ticket" });
    }
  }
);

export default router;
