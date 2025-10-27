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
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const seatKey = (r, c) => `${Number(r)}:${Number(c)}`;

// --- new helpers to generate labels like A7, B12, ... (handles AA, AB, etc.)
function rowToLabel(rowNum) {
  let n = Number(rowNum);
  if (!Number.isInteger(n) || n <= 0) return String(rowNum);
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}
function seatLabel(row, col) {
  return `${rowToLabel(row)}${col}`;
}

// ----------------- Normalized base URL helpers -----------------

function normalizeCandidate(candidate) {
  if (!candidate) return null;
  let s = String(candidate).trim();
  if (!s) return null;
  // If environment provided a Netlify-style URL with protocol already (Netlify's URL often includes https://)
  if (!/^https?:\/\//i.test(s)) {
    // prefer https unless explicitly http provided
    s = `https://${s}`;
  }
  return s.replace(/\/$/, "");
}

/**
 * Resolve the public frontend base URL used for SPA links / QR codes
 * Priority:
 * 1. APP_PUBLIC_BASE (explicit env)
 * 2. CLIENT_BASE_URL (common name)
 * 3. FRONTEND_BASE_URL
 * 4. APP_BASE_URL
 * 5. process.env.URL (Netlify)
 * 6. fallback to localhost dev
 */
function resolveAppPublicBase() {
  const candidates = [
    process.env.APP_PUBLIC_BASE,
    process.env.CLIENT_BASE_URL,
    process.env.FRONTEND_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.VITE_APP_BASE_URL,
    process.env.REACT_APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.URL, // Netlify sometimes sets this
  ].filter(Boolean);

  const picked = candidates.length > 0 ? normalizeCandidate(candidates[0]) : null;

  // If running in production we should avoid defaulting to localhost silently.
  if (process.env.NODE_ENV === "production") {
    if (picked && picked !== "http://localhost:5173") {
      console.info("[BASE_URL] APP_PUBLIC_BASE resolved (production):", picked);
      return picked;
    }
    // try forcing CLIENT_BASE_URL specifically
    if (process.env.CLIENT_BASE_URL) {
      const cb = normalizeCandidate(process.env.CLIENT_BASE_URL);
      console.warn("[BASE_URL] production but initial resolve was unsafe — forcing CLIENT_BASE_URL:", cb);
      return cb;
    }
    // Throw to surface config error in logs rather than issuing localhost links silently
    throw new Error(
      "Missing frontend base URL in production. Set APP_PUBLIC_BASE or CLIENT_BASE_URL environment variable."
    );
  }

  // not production: return picked or default localhost dev URL
  const result = picked || "http://localhost:5173";
  console.info("[BASE_URL] APP_PUBLIC_BASE resolved:", result);
  return result;
}

/**
 * Resolve backend public base (used for direct API/pdf links in emails)
 * Priority:
 * 1. BACKEND_PUBLIC_BASE env
 * 2. constructs from request host is not available here, so fallback to http://localhost:<PORT>
 */
function resolveBackendPublicBase() {
  const picked = process.env.BACKEND_PUBLIC_BASE || null;
  const normalized = normalizeCandidate(picked) || `http://localhost:${process.env.PORT || 8080}`;
  console.info("[BASE_URL] BACKEND_PUBLIC_BASE resolved:", normalized);
  return normalized;
}

// Resolve once at module load time (you can also resolve per-request if you prefer)
let APP_PUBLIC_BASE;
let BACKEND_PUBLIC_BASE;

try {
  APP_PUBLIC_BASE = resolveAppPublicBase();
} catch (err) {
  // If this throws in production, app should fail loudly in logs — but continue in non-production
  console.error("[BASE_URL] failed to resolve APP_PUBLIC_BASE:", err?.message || err);
  // fallback to localhost for safety in dev
  APP_PUBLIC_BASE = process.env.APP_PUBLIC_BASE || "http://localhost:5173";
}

BACKEND_PUBLIC_BASE = resolveBackendPublicBase();

const fmtTime = (d) =>
  new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const pickUserEmail = (reqUser, bookingUser) =>
  bookingUser?.email || reqUser?.email || null;
const pickUserName = (reqUser, bookingUser) =>
  bookingUser?.name ||
  reqUser?.name ||
  (pickUserEmail(reqUser, bookingUser)?.split("@")[0]) ||
  "there";

async function ensureSeatsInitialized(show) {
  if (Array.isArray(show.seats) && show.seats.length > 0) return show;

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

async function reconcileLocks(show) {
  const now = new Date();

  await SeatLock.deleteMany({
    showtime: show._id,
    status: "HELD",
    lockedUntil: { $lte: now },
  });

  const activeLocks = await SeatLock.find({
    showtime: show._id,
    status: "HELD",
    lockedUntil: { $gt: now },
  })
    .select("seat")
    .lean();

  const lockedSet = new Set(activeLocks.map((l) => l.seat));
  let dirty = false;

  for (let i = 0; i < show.seats.length; i++) {
    const s = show.seats[i];
    const k = seatKey(s.row, s.col);

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

async function freeSeatsForBooking(booking) {
  try {
    const show = await Showtime.findById(booking.showtime);
    if (!show) {
      console.error("[cancel] showtime not found for booking", String(booking._id));
      return;
    }
    await ensureSeatsInitialized(show);

    const index = new Map(show.seats.map((s, i) => [seatKey(s.row, s.col), i]));
    for (const s of booking.seats || []) {
      const k = seatKey(s.row, s.col);
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
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

/** 🔒 LOCK */
router.post("/lock", requireAuth, async (req, res) => {
  const tag = "[POST /bookings/lock]";
  try {
    const { showtimeId } = req.body || {};
    let { seats } = req.body || {};

    if (!mongoose.isValidObjectId(showtimeId))
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    if (!Array.isArray(seats) || seats.length === 0)
      return res.status(400).json({ ok: false, error: "seats array is required" });

    const norm = (s) => ({ row: Number(s.row), col: Number(s.col) });
    seats = seats.map(norm).filter((s) => Number.isInteger(s.row) && Number.isInteger(s.col));
    if (seats.length === 0)
      return res.status(400).json({ ok: false, error: "seats must be integers" });

    const uniq = new Map(seats.map((s) => [seatKey(s.row, s.col), s]));
    seats = Array.from(uniq.values());

    let show = await Showtime.findById(showtimeId);
    if (!show) return res.status(404).json({ ok: false, error: "Showtime not found" });
    await ensureSeatsInitialized(show);
    await reconcileLocks(show);

    const idx = new Map(show.seats.map((s, i) => [seatKey(s.row, s.col), i]));
    const toLockKeys = seats.map((s) => seatKey(s.row, s.col));

    const unavailable = [];
    for (const s of seats) {
      const key = seatKey(s.row, s.col);
      const i = idx.get(key);
      const st = i === undefined ? "MISSING" : show.seats[i].status;
      if (i === undefined || st !== "AVAILABLE") {
        unavailable.push({ ...s, current: st });
      }
    }
    if (unavailable.length) {
      return res.status(409).json({ ok: false, error: "Some seats unavailable", details: { unavailable } });
    }

    const lockedUntil = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes
    try {
      await SeatLock.bulkWrite(
        toLockKeys.map((key) => ({
          insertOne: {
            document: {
              showtime: show._id,
              seat: key,
              lockedBy: req.user._id,
              lockedUntil,
              status: "HELD",
              createdAt: new Date(),
            },
          },
        })),
        { ordered: true }
      );
    } catch (err) {
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

    for (const key of toLockKeys) {
      const i = idx.get(key);
      if (i !== undefined) show.seats[i].status = "LOCKED";
    }
    await show.save();

    console.log(tag, "ok", {
      user: String(req.user._id),
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

/** 🔓 RELEASE */
router.post("/release", requireAuth, async (req, res) => {
  const tag = "[POST /bookings/release]";
  try {
    const { showtimeId, seats } = req.body || {};
    if (!mongoose.isValidObjectId(showtimeId))
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });

    let show = await Showtime.findById(showtimeId);
    if (!show) return res.status(404).json({ ok: false, error: "Showtime not found" });
    await ensureSeatsInitialized(show);

    const keys = (seats || []).map((s) => seatKey(s.row, s.col));

    await SeatLock.deleteMany({
      showtime: showtimeId,
      lockedBy: req.user._id,
      seat: { $in: keys },
      status: "HELD",
    });

    await reconcileLocks(show);

    res.json({ ok: true, message: "Released", seats: seats || [] });
  } catch (err) {
    console.error(tag, "Release error:", err);
    res.status(500).json({ ok: false, error: "Failed to release seats" });
  }
});

/** ✅ CONFIRM (atomic) */
router.post("/confirm", requireAuth, async (req, res) => {
  const tag = "[POST /bookings/confirm]";
  try {
    const idemKey = (req.headers["x-idempotency-key"] || "").trim();
    const { showtimeId, seats, amount } = req.body || {};

    if (!mongoose.isValidObjectId(showtimeId))
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    if (!Array.isArray(seats) || seats.length === 0)
      return res.status(400).json({ ok: false, error: "seats array is required" });

    let show = await Showtime.findById(showtimeId).populate("movie");
    if (!show) return res.status(404).json({ ok: false, error: "Showtime not found" });
    await ensureSeatsInitialized(show);
    await reconcileLocks(show);

    // --- normalize seats and add label property
    const normSeats = seats.map((s) => {
      const r = Number(s.row);
      const c = Number(s.col);
      return { row: r, col: c, label: seatLabel(r, c) };
    });
    const keys = normSeats.map((s) => seatKey(s.row, s.col));

    const idx = new Map(show.seats.map((s, i) => [seatKey(s.row, s.col), i]));
    const missing = [];
    for (const k of keys) {
      if (idx.get(k) === undefined) missing.push(k);
    }
    if (missing.length) {
      return res.status(400).json({ ok: false, error: "Unknown seats in snapshot", details: { missing } });
    }

    const now = new Date();
    const activeLocks = await SeatLock.find({
      showtime: show._id,
      lockedBy: req.user._id,
      seat: { $in: keys },
      status: "HELD",
      lockedUntil: { $gt: now },
    })
      .select("seat")
      .lean();

    if (activeLocks.length !== keys.length) {
      return res.status(409).json({ ok: false, error: "Seats already booked or lock expired" });
    }

    if (idemKey) {
      const existing = await Booking.findOne({
        user: req.user._id,
        showtime: show._id,
        "meta.idempotencyKey": idemKey,
      }).lean();
      if (existing) {
        return res.status(200).json({ ok: true, message: "Already confirmed", booking: existing });
      }
    }

    let bookingDoc;
    const session = await mongoose.startSession();

    const execTx = async () => {
      await session.withTransaction(async () => {
        const showForWrite = await Showtime.findById(show._id).session(session);
        await ensureSeatsInitialized(showForWrite);
        await reconcileLocks(showForWrite);

        const localIdx = new Map(showForWrite.seats.map((s, i) => [seatKey(s.row, s.col), i]));

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

        const finalAmount = Number(amount || normSeats.length * Number(show.basePrice || 200));
        const [booking] = await Booking.create(
          [
            {
              user: req.user._id,
              showtime: show._id,
              seats: normSeats,
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
            lockedBy: req.user._id,
            seat: { $in: keys },
            status: "HELD",
          },
          { $set: { status: "USED", usedAt: new Date() } },
          { session }
        );
      });
    };

    try {
      await execTx();
    } catch (e) {
      const isTransient =
        e?.errorLabels?.includes?.("TransientTransactionError") ||
        e?.errorLabels?.includes?.("UnknownTransactionCommitResult");
      if (isTransient) {
        console.warn(tag, "Transient transaction error; retrying once:", e?.message);
        await execTx();
      } else {
        throw e;
      }
    } finally {
      session.endSession();
    }

    // Post-commit side effects (non-blocking)
    (async () => {
      try {
        // USER notification (+ SSE)
        const userNotif = await Notification.create({
          audience: "USER",
          user: req.user._id,
          type: "BOOKING_CONFIRMED",
          title: "🎟️ Booking Confirmed",
          message: `Your booking for "${show.movie?.title || "a movie"}" on ${fmtTime(show.startTime)} has been confirmed.`,
          data: { bookingId: bookingDoc._id, showtimeId: show._id },
          channels: ["IN_APP", "EMAIL"],
        });
        try {
          const delivered = pushNotification?.(userNotif);
          console.log(tag, "pushNotification (user) delivered:", delivered);
        } catch (npErr) {
          console.warn(tag, "pushNotification (user) failed:", npErr?.message);
        }

        // ADMIN notification (+ SSE to admin channel)
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
          console.warn(tag, "admin notification create failed:", anErr?.message);
        }

        // EMAIL (with optional PDF attachment)
        const to = pickUserEmail(req.user, null);
        if (!to) {
          console.warn(tag, "No recipient email; skipping email send.");
        } else {
          const name = pickUserName(req.user, null);
          // prefer labels if present
          const seatsText = normSeats.map((s) => s.label || `${s.row}-${s.col}`).join(", ");

          // Short-lived token so *both* View link and PDF can open from email
          const linkToken = jwt.sign(
            { sub: String(req.user._id), role: "USER" },
            process.env.JWT_SECRET,
            { expiresIn: "24h" }
          );

          const viewUrl = `${APP_PUBLIC_BASE}/bookings/${bookingDoc._id}?token=${encodeURIComponent(linkToken)}`;
          const pdfUrl  = `${BACKEND_PUBLIC_BASE}/api/bookings/${bookingDoc._id}/pdf?token=${encodeURIComponent(linkToken)}`;

          const html =
            renderTemplate?.("booking-confirmed", {
              name,
              movieTitle: show.movie?.title || "your movie",
              showtime: fmtTime(show.startTime),
              seats: seatsText,
              bookingId: String(bookingDoc._id),
              ticketViewUrl: viewUrl,
              ticketPdfUrl: pdfUrl,
            }) || `<p>${userNotif.message}</p>`;

          let attachments = [];
          try {
            const { buffer } = await generateTicketPdf(
              bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc,
              { name, email: to },
              show,
              { baseUrl: APP_PUBLIC_BASE } // ✅ explicit baseUrl (comes from resolved APP_PUBLIC_BASE above)
            );
            if (buffer) {
              attachments.push({
                filename: `Ticket-${String(bookingDoc._id)}.pdf`,
                content: buffer,
                contentType: "application/pdf",
              });
            }
          } catch (pdfErr) {
            console.warn(tag, "Ticket PDF generation failed (email will still send):", pdfErr?.message);
          }

          const mailRes = await sendEmail({ to, subject: userNotif.title, html, attachments });
          if (!mailRes?.ok) {
            console.error(tag, "❌ Email failed:", mailRes?.error || "unknown");
          } else {
            console.log(tag, "📧 Email sent:", mailRes.messageId, mailRes.previewUrl || "");
          }
        }
      } catch (e) {
        console.warn(tag, "Notification/email failed:", e?.message);
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

/** 👤 USER’s bookings */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user._id })
      .populate({
        path: "showtime",
        populate: [
          { path: "movie", select: "title posterUrl runtime" },
          { path: "screen", select: "name" },
        ],
      })
      .sort({ createdAt: -1 })
      .lean();

    // ensure older bookings without label still show as row-col
    const normalized = bookings.map((b) => {
      b.seats = (b.seats || []).map((s) => {
        if (!s) return s;
        return { row: s.row, col: s.col, label: s.label || seatLabel(s.row, s.col) };
      });
      return b;
    });

    res.json({ ok: true, bookings: normalized });
  } catch (err) {
    console.error("Fetch bookings error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch bookings" });
  }
});

/** 🧾 SINGLE booking details — ADMIN can view any booking; accepts ?token=... */
router.get(
  "/:id",
  (req, _res, next) => {
    if (req.query?.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
    next();
  },
  requireAuth,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ ok: false, error: "Invalid booking id" });
      }

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
      if (!isAdmin && bookingUserId !== String(req.user._id)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      // ensure seats have labels for older bookings
      booking.seats = (booking.seats || []).map((s) => {
        if (!s) return s;
        return { row: s.row, col: s.col, label: s.label || seatLabel(s.row, s.col) };
      });

      res.json({ ok: true, booking });
    } catch (err) {
      console.error("Fetch booking error:", err);
      res.status(500).json({ ok: false, error: "Failed to fetch bookings" });
    }
  }
);

/** ❌ CANCEL (DELETE style) */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate({
      path: "showtime",
      populate: { path: "movie", select: "title" },
    });
    if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

    if (String(booking.user) !== String(req.user._id))
      return res.status(403).json({ ok: false, error: "Forbidden" });

    if (booking.status === "CANCELLED") {
      return res.status(200).json({ ok: true, message: "Already cancelled", bookingId: booking._id });
    }

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    await booking.save();
    await freeSeatsForBooking(booking);

    (async () => {
      try {
        // USER notification
        const notif = await Notification.create({
          audience: "USER",
          user: booking.user,
          type: "BOOKING_CANCELLED",
          title: "❌ Booking Cancelled",
          message: `Your booking for "${booking.showtime?.movie?.title}" has been cancelled.`,
          data: { bookingId: booking._id },
          channels: ["IN_APP", "EMAIL"],
        });
        try { pushNotification?.(notif); } catch {}

        // ADMIN notification
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

        // EMAIL
        const to = pickUserEmail(req.user, booking.user);
        if (!to) {
          console.warn("[delete cancel] No recipient email; skipping email send.");
        } else {
          const html =
            renderTemplate?.("booking-cancelled", {
              name: pickUserName(req.user, booking.user),
              movieTitle: booking.showtime?.movie?.title || "your movie",
              bookingId: String(booking._id),
              ticketViewUrl: `${APP_PUBLIC_BASE}/bookings/${booking._id}`,
            }) || `<p>${notif.message}</p>`;
          const mailRes = await sendEmail({ to, subject: notif.title, html });
          if (!mailRes?.ok) console.error("[delete cancel] ❌ Email failed:", mailRes?.error || "unknown");
          else console.log("[delete cancel] 📧 Email sent:", mailRes.messageId, mailRes.previewUrl || "");
        }
      } catch (e) {
        console.warn("[delete cancel] Notification/email failed:", e?.message);
      }
    })();

    res.json({ ok: true, message: "Booking cancelled", bookingId: booking._id });
  } catch (err) {
    console.error("Cancel booking (DELETE) error:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to cancel booking" });
  }
});

/** ❌ CANCEL (PATCH style) */
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  const tag = "[PATCH /bookings/:id/cancel]";
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid booking id" });
    }

    const booking = await Booking.findById(id).populate({
      path: "showtime",
      populate: { path: "movie", select: "title" },
    });
    if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });
    if (String(booking.user) !== String(req.user._id))
      return res.status(403).json({ ok: false, error: "Forbidden" });

    if (booking.status === "CANCELLED") {
      return res.status(200).json({ ok: true, message: "Already cancelled", bookingId: booking._id });
    }

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    await booking.save();
    await freeSeatsForBooking(booking);

    (async () => {
      try {
        // USER notification
        const notif = await Notification.create({
          audience: "USER",
          user: booking.user,
          type: "BOOKING_CANCELLED",
          title: "❌ Booking Cancelled",
          message: `Your booking for "${booking.showtime?.movie?.title || "a movie"}" has been cancelled.`,

          data: { bookingId: booking._id },
          channels: ["IN_APP", "EMAIL"],
        });
        try { pushNotification?.(notif); } catch {}

        // ADMIN notification
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

        // EMAIL
        const to = pickUserEmail(req.user, booking.user);
        if (!to) {
          console.warn(tag, "No recipient email; skipping email send.");
        } else {
          const html =
            renderTemplate?.("booking-cancelled", {
              name: pickUserName(req.user, booking.user),
              movieTitle: booking.showtime?.movie?.title || "your movie",
              bookingId: String(booking._id),
              ticketViewUrl: `${APP_PUBLIC_BASE}/bookings/${booking._id}`,
            }) || `<p>${notif.message}</p>`;
          const mailRes = await sendEmail({ to, subject: notif.title, html });
          if (!mailRes?.ok) console.error(tag, "❌ Email failed:", mailRes?.error || "unknown");
          else console.log(tag, "📧 Email sent:", mailRes.messageId, mailRes.previewUrl || "");
        }
      } catch (e) {
        console.warn(tag, "Notification/email failed:", e?.message);
      }
    })();

    return res.json({ ok: true, message: "Booking cancelled", bookingId: booking._id });
  } catch (err) {
    console.error(tag, "error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to cancel booking" });
  }
});

/** 🗓️ CALENDAR */
router.get("/calendar", requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = start ? new Date(start) : new Date();
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 86400000);

    const bookings = await Booking.find({ user: req.user._id })
      .populate({
        path: "showtime",
        populate: { path: "movie", select: "title posterUrl" },
      })
      .lean();

    const events = bookings
      .map((b) => ({

        id: b._id,
        title: b.showtime?.movie?.title || "Booking",
        start: b.showtime?.startTime,
        raw: b,
      }))
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

/** 🧾 PDF Ticket Generator — ADMIN can download any ticket
 *  Uses requireAuth, but allows token via ?token=... for window.open/email flows.
 */
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
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ ok: false, error: "Invalid booking id" });
      }

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
      if (!isAdmin && bookingUserId !== String(req.user._id)) {
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

      // ensure seats have labels for PDF generation
      booking.seats = (booking.seats || []).map((s) => {
        if (!s) return s;
        return { row: s.row, col: s.col, label: s.label || seatLabel(s.row, s.col) };
      });

      const { buffer } = await generateTicketPdf(
        booking,
        userForPdf,
        booking.showtime,
        { baseUrl: APP_PUBLIC_BASE } // ✅ explicit baseUrl (resolved above)
      );

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
