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
import User from "../models/User.js"; // ✅ added

import { requireAuth } from "../middleware/auth.js";
import { pushNotification } from "./notifications.routes.js"; // emits event: "notification"
import { sendEmail, renderTemplate } from "../models/mailer.js";

// 🔐 seat lock service
import { lockSeats } from "../services/seatLock.service.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                                  Config                                    */
/* -------------------------------------------------------------------------- */

const APP_PUBLIC_BASE =
  process.env.APP_PUBLIC_BASE ||
  process.env.APP_BASE_URL ||
  "http://localhost:5173";

const BACKEND_PUBLIC_BASE =
  process.env.BACKEND_PUBLIC_BASE ||
  `http://localhost:${process.env.PORT || 8080}`;

const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
const SEAT_LOCK_TTL_MS = Number(
  process.env.SEAT_LOCK_TTL_MS || 2 * 60 * 1000
); // 2 minutes default

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Convert row letters (A, B, AA, etc.) to row number (1-based).
 */
const lettersToNumber = (letters) => {
  if (!letters) return NaN;
  const s = String(letters).toUpperCase().replace(/[^A-Z]/g, "");
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64); // A -> 1, B -> 2, ...
  }
  return n;
};

/**
 * Normalize any seat-like value to a canonical "row:col" string.
 *
 * Supports:
 *  - { row, col }
 *  - { seatId }, { seat }, { label } like "B2"
 *  - "2:2", "2-2", "2_2"
 *  - "A1", "AA10", "B-2"
 */
const normalizeSeatKey = (seat) => {
  if (!seat && seat !== 0) return null;

  // Object form
  if (typeof seat === "object" && seat !== null) {
    // 1️⃣ Prefer row/col if present – matches your Mongo schema
    if (seat.row !== undefined && seat.col !== undefined) {
      const r = Number(seat.row);
      const c = Number(seat.col);
      if (Number.isFinite(r) && Number.isFinite(c)) {
        return `${Math.floor(r)}:${Math.floor(c)}`;
      }
    }

    // 2️⃣ Fallback to seatId / seat / label
    const label = seat.seatId ?? seat.seat ?? seat.label;
    if (label != null) {
      return normalizeSeatKey(String(label));
    }

    return null;
  }

  // String form
  if (typeof seat === "string") {
    const s = seat.trim();

    // "r:c", "r-c", "r_c"
    let m = s.match(/^(\d+)[\s:_-]?(\d+)$/);
    if (m) {
      return `${parseInt(m[1], 10)}:${parseInt(m[2], 10)}`;
    }

    // "A1", "AA12", "B-2"
    m = s.match(/^([A-Za-z]+)[\s_-]*([0-9]+)$/);
    if (m) {
      const row = lettersToNumber(m[1]);
      const col = parseInt(m[2], 10);
      if (Number.isFinite(row) && Number.isFinite(col)) {
        return `${row}:${col}`;
      }
    }

    // Fallback: legacy compat
    return s.toUpperCase();
  }

  if (typeof seat === "number") return String(seat);
  return String(seat).trim();
};

/** Build a canonical key for seat lookup from user/booking payload */
const seatKeyFrom = (seat) => normalizeSeatKey(seat);

/** For showtime seat snapshot */
const seatKeyForSnapshot = (s) => normalizeSeatKey(s);

const fmtTime = (d) =>
  new Date(d).toLocaleString("en-IN", { timeZone: TIMEZONE });

const pickUserEmail = (reqUser, bookingUser) =>
  bookingUser?.email || reqUser?.email || null;

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
  const cols = Number(screen?.cols || screen?.columns || 10);

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
  })
    .select("seat")
    .lean();

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
/*                               Seat utilities                               */
/* -------------------------------------------------------------------------- */

function normalizeRequestedSeats(seats = []) {
  // Accept either array of {seatId} or {row,col} or mixed.
  const out = [];
  for (const s of seats) {
    if (!s) continue;
    if (s.seatId) out.push({ seatId: String(s.seatId) });
    else if (s.row !== undefined && s.col !== undefined) {
      out.push({ row: Number(s.row), col: Number(s.col) });
    }
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
/*                             Free seats helper                              */
/* -------------------------------------------------------------------------- */

async function freeSeatsForBooking(booking) {
  try {
    const show = await Showtime.findById(booking.showtime);
    if (!show) {
      console.error(
        "[freeSeatsForBooking] showtime not found for booking",
        String(booking._id)
      );
      return;
    }
    await ensureSeatsInitialized(show);

    const index = new Map(
      show.seats.map((s, i) => [seatKeyForSnapshot(s), i])
    );
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
/*                                Seat Locking                                */
/* -------------------------------------------------------------------------- */

/** 🔒 LOCK seats — delegate to seatLock.service */
router.post("/lock", requireAuth(), async (req, res) => {
  const tag = "[POST /bookings/lock]";
  try {
    const { showtimeId } = req.body || {};
    let seats = normalizeRequestedSeats(req.body?.seats || []);

    if (!mongoose.isValidObjectId(showtimeId)) {
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    }
    if (!seats.length) {
      return res
        .status(400)
        .json({ ok: false, error: "seats array is required" });
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Unauthenticated" });
    }

    // Canonical seat keys ("row:col" or "A1") → let lockSeats.normalizeSeat handle them
    const canonicalSeats = seats
      .map((s) => seatKeyFrom(s))
      .filter(Boolean);

    const result = await lockSeats({
      showtimeId,
      seats: canonicalSeats,
      userId,
    });

    if (!result.ok) {
      if (result.conflicts && result.conflicts.length > 0) {
        console.warn(`${tag} conflicts:`, result.conflicts);
        return res.status(409).json({
          ok: false,
          error: "Some seats are already locked or booked",
          conflicts: result.conflicts,
        });
      }

      const msg = result.error || "Failed to lock seats";
      console.error(`${tag} service error:`, msg);
      return res.status(400).json({
        ok: false,
        error: msg,
      });
    }

    console.log(tag, "ok", {
      user: String(userId),
      showtime: String(showtimeId),
      seats: canonicalSeats,
      lockedUntil: result.lockedUntil?.toISOString?.() || result.lockedUntil,
    });

    return res.json({
      ok: true,
      message: "Seats locked",
      seats: canonicalSeats,
      lockedUntil: result.lockedUntil,
      serverTime: new Date(),
    });
  } catch (err) {
    console.error("[POST /bookings/lock] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to lock seats",
      details:
        process.env.NODE_ENV === "development"
          ? { message: err?.message, stack: err?.stack }
          : undefined,
    });
  }
});

/** 🔄 EXTEND current user's locks for a showtime */
router.post("/lock/extend", requireAuth(), async (req, res) => {
  const tag = "[POST /bookings/lock/extend]";
  try {
    const { showtimeId } = req.body || {};

    if (!mongoose.isValidObjectId(showtimeId)) {
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Unauthenticated" });
    }

    const now = new Date();
    const newLockedUntil = new Date(now.getTime() + SEAT_LOCK_TTL_MS);

    const result = await SeatLock.updateMany(
      {
        showtime: showtimeId,
        lockedBy: userId,
        status: "HELD",
        lockedUntil: { $gt: now },
      },
      {
        $set: { lockedUntil: newLockedUntil },
      }
    );

    console.log(tag, {
      user: String(userId),
      showtime: String(showtimeId),
      matched: result.matchedCount,
      modified: result.modifiedCount,
      lockedUntil: newLockedUntil.toISOString(),
    });

    return res.json({
      ok: true,
      message: "Lock extended",
      lockedUntil: newLockedUntil,
      serverTime: now,
    });
  } catch (err) {
    console.error("[POST /bookings/lock/extend] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to extend lock",
      details:
        process.env.NODE_ENV === "development"
          ? { message: err?.message, stack: err?.stack }
          : undefined,
    });
  }
});

/** 🔓 RELEASE seats held by requester */
router.post("/release", requireAuth(), async (req, res) => {
  const tag = "[POST /bookings/release]";
  try {
    const { showtimeId } = req.body || {};
    let seats = normalizeRequestedSeats(req.body?.seats || []);

    if (!mongoose.isValidObjectId(showtimeId)) {
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    }

    const show = await Showtime.findById(showtimeId);
    if (!show) {
      return res
        .status(404)
        .json({ ok: false, error: "Showtime not found" });
    }

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

    return res.json({
      ok: true,
      message: "Released",
      releasedCount: deleted.deletedCount || 0,
      seats: seats || [],
    });
  } catch (err) {
    console.error(tag, "Release error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to release seats" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               Confirm Booking                              */
/* -------------------------------------------------------------------------- */

/** ✅ CONFIRM booking (atomic transaction, uses SeatLock as source of truth) */
router.post("/confirm", requireAuth(), async (req, res) => {
  const tag = "[POST /bookings/confirm]";
  try {
    const idemKey =
      String(req.headers["x-idempotency-key"] || "").trim() || null;

    const { showtimeId } = req.body || {};
    const amountFromClient = req.body?.amount;

    if (!mongoose.isValidObjectId(showtimeId)) {
      return res.status(400).json({ ok: false, error: "Invalid showtimeId" });
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Unauthenticated" });
    }

    // Load showtime + movie
    let show = await Showtime.findById(showtimeId).populate("movie");
    if (!show) {
      return res.status(404).json({ ok: false, error: "Showtime not found" });
    }

    await ensureSeatsInitialized(show);
    await reconcileLocks(show);

    const now = new Date();

    // 1️⃣ Get all active locks for this user + showtime
    const activeLocks = await SeatLock.find({
      showtime: show._id,
      lockedBy: userId,
      status: "HELD",
      lockedUntil: { $gt: now },
    })
      .select("seat")
      .lean();

    if (!activeLocks.length) {
      return res.status(409).json({
        ok: false,
        error: "No active seat locks found for this showtime",
      });
    }

    // Canonical keys derived from SeatLock.seat (NOT client payload)
    const seatKeys = activeLocks
      .map((l) => seatKeyFrom(l.seat))
      .filter(Boolean);

    // Build snapshot index
    const idx = new Map(
      show.seats.map((s, i) => [seatKeyForSnapshot(s), i])
    );

    // 2️⃣ Verify that all locked seats exist in snapshot
    const missing = [];
    for (const k of seatKeys) {
      if (idx.get(k) === undefined) missing.push(k);
    }
    if (missing.length) {
      // This should be extremely rare — indicates inconsistent schema
      return res.status(400).json({
        ok: false,
        error: "Unknown seats in snapshot",
        details: { missing },
      });
    }

    // Idempotency: has this already been booked?
    if (idemKey) {
      const existing = await Booking.findOne({
        user: userId,
        showtime: show._id,
        "meta.idempotencyKey": idemKey,
      }).lean();
      if (existing) {
        return res
          .status(200)
          .json({ ok: true, message: "Already confirmed", booking: existing });
      }
    }

    // Seats in Booking document → stored as { seatId }
    const seatsForBooking = activeLocks.map((l) => ({
      seatId: String(l.seat),
    }));

    // 3️⃣ Transaction: mark seats BOOKED, create Booking, mark locks USED
    let bookingDoc = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const showForWrite = await Showtime.findById(show._id).session(
          session
        );
        await ensureSeatsInitialized(showForWrite);
        await reconcileLocks(showForWrite);

        const localIdx = new Map(
          showForWrite.seats.map((s, i) => [seatKeyForSnapshot(s), i])
        );

        // Verify seat statuses and set to BOOKED
        for (const k of seatKeys) {
          const i = localIdx.get(k);
          if (i === undefined) {
            const err = new Error(`Seat missing in snapshot: ${k}`);
            err.code = "SEAT_MISSING";
            throw err;
          }
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

        const finalAmount = Number(
          amountFromClient ||
            seatsForBooking.length * Number(show.basePrice || 200)
        );

        const [booking] = await Booking.create(
          [
            {
              user: userId,
              showtime: show._id,
              seats: seatsForBooking, // { seatId: "..." }
              totalAmount: finalAmount,
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
            seat: { $in: seatKeys },
            status: "HELD",
          },
          { $set: { status: "USED", usedAt: new Date() } },
          { session }
        );
      });
    } finally {
      session.endSession();
    }

    // ----------------------- Post-commit side effects ----------------------- //
    (async () => {
      try {
        // Reload showtime with screen + theater so we can resolve theatre/admin
        let showWithTheatre = null;
        try {
          showWithTheatre = await Showtime.findById(show._id)
            .populate({
              path: "screen",
              populate: {
                path: "theater",
                // Adjust field names based on your Theater schema
                select:
                  "_id name city state admin owner createdBy theatreAdminUser",
              },
            })
            .lean();
        } catch (e) {
          console.warn(
            "Failed to load showtime+theater for notifications:",
            e?.message
          );
        }

        let theatreId = showWithTheatre?.screen?.theater?._id || null;

        // 1️⃣ Try to resolve theatre admin from Theater document
        let theatreAdminUserId =
          showWithTheatre?.screen?.theater?.admin ||
          showWithTheatre?.screen?.theater?.owner ||
          showWithTheatre?.screen?.theater?.createdBy ||
          showWithTheatre?.screen?.theater?.theatreAdminUser ||
          null;

        // 2️⃣ Fallback: resolve theatre admin from User collection by theatreId
        if (!theatreAdminUserId && theatreId) {
          try {
            const theatreAdminDoc = await User.findOne({
              role: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] },
              $or: [
                { theatre: theatreId },
                { theatreId },
                { theater: theatreId },
                { theaterId },
              ],
            })
              .select("_id email name role")
              .lean();

            if (theatreAdminDoc?._id) {
              theatreAdminUserId = theatreAdminDoc._id;
            }
          } catch (err) {
            console.warn(
              "Failed to resolve theatre admin user from User:",
              err?.message
            );
          }
        }

        console.log("[BOOKING_CONFIRM] theatre info", {
          theatreId: theatreId ? String(theatreId) : null,
          theatreAdminUserId: theatreAdminUserId
            ? String(theatreAdminUserId)
            : null,
        });

        // USER notification
        const userNotif = await Notification.create({
          audience: "USER",
          user: userId,
          type: "BOOKING_CONFIRMED",
          title: "🎟️ Booking Confirmed",
          message: `Your booking for "${
            show.movie?.title || "a movie"
          }" on ${fmtTime(show.startTime)} has been confirmed.`,
          data: {
            bookingId: bookingDoc._id,
            showtimeId: show._id,
            theatreId,
          },
          channels: ["IN_APP", "EMAIL"],
        });
        try {
          pushNotification?.(userNotif);
        } catch (e) {
          console.warn("pushNotification user failed:", e?.message);
        }

        // 🎭 THEATRE ADMIN notification (only this theatre)
        if (theatreAdminUserId) {
          try {
            const theatreAdminNotif = await Notification.create({
              audience: "THEATRE_ADMIN",
              user: theatreAdminUserId,
              theatreId: theatreId || null,
              type: "BOOKING_CONFIRMED",
              title: "New booking",
              message: `New booking #${String(bookingDoc._id)} for "${
                show.movie?.title || "a movie"
              }" on ${fmtTime(show.startTime)}.`,
              data: {
                bookingId: bookingDoc._id,
                showtimeId: show._id,
                theatreId,
                customer: {
                  id: userId,
                  name: req.user?.name || null,
                  email: req.user?.email || null,
                  phone: req.user?.phone || null,
                },
              },
              channels: ["IN_APP"],
            });
            pushNotification?.(theatreAdminNotif);
          } catch (taErr) {
            console.warn(
              "theatre-admin notification create failed:",
              taErr?.message
            );
          }
        } else {
          console.warn(
            "No theatreAdminUserId resolved; skipping THEATRE_ADMIN notification"
          );
        }

        // (Optional) GLOBAL ADMIN notification for super admin dashboards
        try {
          const adminNotif = await Notification.create({
            audience: "ADMIN",
            theatreId: theatreId || null,
            type: "BOOKING_CONFIRMED",
            title: "New booking",
            message: `Booking #${String(bookingDoc._id)} by ${
              req.user?.email || "user"
            }`,
            data: {
              bookingId: bookingDoc._id,
              showtimeId: show._id,
              theatreId,
              customer: {
                id: userId,
                name: req.user?.name || null,
                email: req.user?.email || null,
                phone: req.user?.phone || null,
              },
              movie: show.movie
                ? {
                    id: show.movie._id,
                    title: show.movie.title,
                    posterUrl: show.movie.posterUrl || null,
                  }
                : null,
            },
            channels: ["IN_APP"],
          });
          pushNotification?.(adminNotif);
        } catch (anErr) {
          console.warn("admin notification create failed:", anErr?.message);
        }

        // Email
        const to = pickUserEmail(req.user, null);
        if (!to) {
          console.warn("No recipient email; skipping email send.");
        } else {
          const name = pickUserName(req.user, null);
          const seatsText = seatsForBooking.map((s) => s.seatId).join(", ");

          const linkToken = jwt.sign(
            { sub: String(userId), role: "USER" },
            process.env.JWT_SECRET,
            { expiresIn: "24h" }
          );

          const viewUrl = `${APP_PUBLIC_BASE}/bookings/${bookingDoc._id}?token=${encodeURIComponent(
            linkToken
          )}`;
          const pdfUrl = `${BACKEND_PUBLIC_BASE}/api/bookings/${bookingDoc._id}/pdf?token=${encodeURIComponent(
            linkToken
          )}`;

          const html =
            (renderTemplate &&
              renderTemplate("booking-confirmed", {
                name,
                movieTitle: show.movie?.title || "your movie",
                showtime: fmtTime(show.startTime),
                seats: seatsText,
                bookingId: String(bookingDoc._id),
                ticketViewUrl: viewUrl,
                ticketPdfUrl: pdfUrl,
              })) ||
            `<p>Your booking for ${show.movie?.title} is confirmed.</p>`;

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
            console.warn(
              "Ticket PDF generation failed (email will still send):",
              pdfErr?.message
            );
          }

          const mailRes = await sendEmail({
            to,
            subject: userNotif.title,
            html,
            attachments,
          });
          if (!mailRes?.ok)
            console.error("Email failed:", mailRes?.error || "unknown");
          else
            console.log(
              "Email sent:",
              mailRes.messageId,
              mailRes.previewUrl || ""
            );
        }
      } catch (e) {
        console.warn(
          "Notification/email post-commit failed:",
          e?.message || e
        );
      }
    })();

    return res
      .status(201)
      .json({ ok: true, message: "Booking confirmed", booking: bookingDoc });
  } catch (err) {
    console.error("[Confirm booking] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to confirm booking",
      details:
        process.env.NODE_ENV === "development"
          ? { message: err?.message, code: err?.code }
          : undefined,
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                           User Bookings + Details                          */
/* -------------------------------------------------------------------------- */

/** 🧾 USER's bookings */
router.get("/me", requireAuth(), async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    console.log("[GET /api/bookings/me] user:", String(userId));

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

    return res.json({ ok: true, bookings });
  } catch (err) {
    console.error("Fetch bookings error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to fetch bookings" });
  }
});

/* -------------------------------------------------------------------------- */
/*                           Calendar View for User                           */
/* -------------------------------------------------------------------------- */

router.get("/calendar", requireAuth(), async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = start ? new Date(start) : new Date();
    const endDate = end
      ? new Date(end)
      : new Date(startDate.getTime() + 90 * 86400000);

    const userId = req.user?.id || req.user?._id;
    const bookings = await Booking.find({ user: userId })
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

    return res.json({ ok: true, events });
  } catch (err) {
    console.error("Calendar error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load calendar" });
  }
});

/* -------------------------------------------------------------------------- */
/*                     SINGLE booking details — accepts ?token=               */
/* -------------------------------------------------------------------------- */

router.get(
  "/:id",
  (req, _res, next) => {
    if (req.query?.token && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
    next();
  },
  requireAuth(),
  async (req, res) => {
    const bookingId = req.params.id;
    const currentUserId = String(req.user?.id || req.user?._id || "");
    const role = String(req.user?.role || "").toUpperCase();

    const isSuperAdmin = role === "SUPER_ADMIN";
    const isTheatreAdmin = role === "THEATRE_ADMIN";
    const isAdmin = isSuperAdmin || isTheatreAdmin;

    console.log(
      "[GET /api/bookings/:id] hit",
      "bookingId=",
      bookingId,
      "userId=",
      currentUserId,
      "role=",
      role
    );

    try {
      if (!mongoose.isValidObjectId(bookingId)) {
        console.warn("[GET /bookings/:id] invalid id:", bookingId);
        return res
          .status(400)
          .json({ ok: false, error: "Invalid booking id" });
      }

      let booking = await Booking.findById(bookingId)
        .populate({
          path: "showtime",
          populate: [
            {
              path: "movie",
              select: "title posterUrl runtime language certificate",
            },
            {
              path: "screen",
              populate: {
                path: "theater",
                select: "name city state address",
              },
            },
          ],
        })
        .populate({ path: "user", select: "name email phone role" })
        .lean();

      if (!booking) {
        console.warn("[GET /bookings/:id] not found:", bookingId);
        return res
          .status(404)
          .json({ ok: false, error: "Booking not found" });
      }

      if (!booking.movie && booking.showtime?.movie) {
        booking.movie = booking.showtime.movie;
      }

      const bookingUserId = String(
        booking.user?._id || booking.user || ""
      );
      const userIsOwner =
        currentUserId && bookingUserId && currentUserId === bookingUserId;

      if (!userIsOwner && !isAdmin) {
        console.warn(
          "[GET /bookings/:id] forbidden for user=",
          currentUserId,
          "role=",
          role,
          "bookingUserId=",
          bookingUserId
        );
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      console.log(
        "[GET /bookings/:id] success, bookingId=",
        bookingId,
        "status=",
        booking.status
      );

      return res.json({ ok: true, booking });
    } catch (err) {
      console.error("[GET /bookings/:id] error:", err);
      return res
        .status(500)
        .json({ ok: false, error: "Failed to fetch booking" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                              Cancel Booking                                */
/* -------------------------------------------------------------------------- */

async function handleCancelBooking(req, res) {
  try {
    const booking = await Booking.findById(req.params.id).populate({
      path: "showtime",
      populate: { path: "movie", select: "title" },
    });

    if (!booking) {
      return res
        .status(404)
        .json({ ok: false, error: "Booking not found" });
    }

    const userId = String(req.user?.id || req.user?._id);
    if (String(booking.user) !== userId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    if (booking.status === "CANCELLED") {
      return res.status(200).json({
        ok: true,
        message: "Already cancelled",
        bookingId: booking._id,
      });
    }

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    await booking.save();
    await freeSeatsForBooking(booking);

    (async () => {
      try {
        const notif = await Notification.create({
          audience: "USER",
          user: booking.user,
          type: "BOOKING_CANCELLED",
          title: "❌ Booking Cancelled",
          message: `Your booking for "${
            booking.showtime?.movie?.title
          }" has been cancelled.`,
          data: { bookingId: booking._id },
          channels: ["IN_APP", "EMAIL"],
        });
        try {
          pushNotification?.(notif);
        } catch (e) {}

        // Resolve theatre + theatre admin for this booking's showtime
        let theatreId = null;
        let theatreAdminUserId = null;
        try {
          const showWithTheatre = await Showtime.findById(booking.showtime)
            .populate({
              path: "screen",
              populate: {
                path: "theater",
                select:
                  "_id name city state admin owner createdBy theatreAdminUser",
              },
            })
            .lean();

          theatreId = showWithTheatre?.screen?.theater?._id || null;

          // 1️⃣ Try fields on Theater
          theatreAdminUserId =
            showWithTheatre?.screen?.theater?.admin ||
            showWithTheatre?.screen?.theater?.owner ||
            showWithTheatre?.screen?.theater?.createdBy ||
            showWithTheatre?.screen?.theater?.theatreAdminUser ||
            null;

          // 2️⃣ Fallback to User collection
          if (!theatreAdminUserId && theatreId) {
            try {
              const theatreAdminDoc = await User.findOne({
                role: { $in: ["THEATRE_ADMIN", "THEATER_ADMIN"] },
                $or: [
                  { theatre: theatreId },
                  { theatreId },
                  { theater: theatreId },
                  { theaterId },
                ],
              })
                .select("_id email name role")
                .lean();

              if (theatreAdminDoc?._id) {
                theatreAdminUserId = theatreAdminDoc._id;
              }
            } catch (err) {
              console.warn(
                "Failed to resolve theatre admin user (cancel):",
                err?.message
              );
            }
          }

          console.log("[BOOKING_CANCEL] theatre info", {
            theatreId: theatreId ? String(theatreId) : null,
            theatreAdminUserId: theatreAdminUserId
              ? String(theatreAdminUserId)
              : null,
          });
        } catch (e2) {
          console.warn(
            "Failed to load theatre for cancellation notification:",
            e2?.message
          );
        }

        // 🎭 THEATRE ADMIN cancellation notification
        if (theatreAdminUserId) {
          try {
            const theatreAdminCancel = await Notification.create({
              audience: "THEATRE_ADMIN",
              user: theatreAdminUserId,
              theatreId: theatreId || null,
              type: "BOOKING_CANCELLED",
              title: "Booking cancelled",
              message: `Booking #${String(booking._id)} was cancelled by ${
                req.user?.email || "user"
              }`,
              data: {
                bookingId: booking._id,
                theatreId,
                userEmail: req.user?.email,
              },
              channels: ["IN_APP"],
            });
            pushNotification?.(theatreAdminCancel);
          } catch (taErr) {
            console.warn(
              "theatre-admin cancel notification failed:",
              taErr?.message
            );
          }
        }

        // Optional: global ADMIN cancel notification for super admin
        try {
          const adminCancel = await Notification.create({
            audience: "ADMIN",
            theatreId: theatreId || null,
            type: "BOOKING_CANCELLED",
            title: "Booking cancelled",
            message: `Booking #${String(booking._id)} cancelled by ${
              req.user?.email || "user"
            }`,
            data: {
              bookingId: booking._id,
              theatreId,
              userEmail: req.user?.email,
            },
            channels: ["IN_APP"],
          });
          pushNotification?.(adminCancel);
        } catch {}

        const to = pickUserEmail(req.user, booking.user);
        if (to) {
          const html =
            (renderTemplate &&
              renderTemplate("booking-cancelled", {
                name: pickUserName(req.user, booking.user),
                movieTitle:
                  booking.showtime?.movie?.title || "your movie",
                bookingId: String(booking._id),
                ticketViewUrl: `${APP_PUBLIC_BASE}/bookings/${booking._id}`,
              })) || `<p>${notif.message}</p>`;

          const mailRes = await sendEmail({
            to,
            subject: notif.title,
            html,
          });
          if (!mailRes?.ok)
            console.error("Email failed:", mailRes?.error || "unknown");
          else
            console.log(
              "Email sent:",
              mailRes.messageId,
              mailRes.previewUrl || ""
            );
        }
      } catch (e) {
        console.warn(
          "Cancellation notification/email failed:",
          e?.message
        );
      }
    })();

    return res.json({
      ok: true,
      message: "Booking cancelled",
      bookingId: booking._id,
    });
  } catch (err) {
    console.error("Cancel booking error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Failed to cancel booking" });
  }
}

/** ❌ CANCEL booking (DELETE) */
router.delete("/:id", requireAuth(), handleCancelBooking);

/** ❌ CANCEL (PATCH style) — reuse same handler */
router.patch("/:id/cancel", requireAuth(), handleCancelBooking);

/* -------------------------------------------------------------------------- */
/*                           PDF Ticket Generation                            */
/* -------------------------------------------------------------------------- */

router.get(
  "/:id/pdf",
  (req, _res, next) => {
    if (!req.headers.authorization && req.query?.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
    next();
  },
  requireAuth(),
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid booking id" });
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

      if (!booking) {
        return res.status(404).json({ ok: false, error: "Not found" });
      }

      const isAdmin = String(req.user?.role || "")
        .toUpperCase()
        .includes("ADMIN");
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

      const { buffer } = await generateTicketPdf(
        booking,
        userForPdf,
        booking.showtime,
        { baseUrl: APP_PUBLIC_BASE }
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=ticket-${booking._id}.pdf`
      );
      return res.send(buffer);
    } catch (err) {
      console.error("PDF generation error:", err);
      return res
        .status(500)
        .json({ ok: false, error: "Failed to generate ticket" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                            Theatre Reports / Analytics                     */
/* -------------------------------------------------------------------------- */

router.get("/theatre/reports", requireAuth(), async (req, res) => {
  try {
    const role = String(req.user?.role || "").toUpperCase();
    const isTheatreAdmin =
      role === "THEATRE_ADMIN" || role === "THEATER_ADMIN";

    if (!isTheatreAdmin) {
      return res
        .status(403)
        .json({ ok: false, error: "Only theatre admins can view this" });
    }

    // Determine theatreId from user / token
    const theatreId =
      req.user.theatre?._id ||
      req.user.theatreId ||
      req.user.theatre ||
      req.user.theater?._id ||
      req.user.theaterId ||
      req.user.theater ||
      null;

    if (!theatreId || !mongoose.isValidObjectId(theatreId)) {
      return res.status(400).json({
        ok: false,
        error: "Theatre id not found on user (theatre admin)",
      });
    }

    // read query params from frontend
    const { startDate, endDate } = req.query;

    // if frontend sends yyyy-mm-dd
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date();

    // normalize to full-day range
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    // match on theatre + createdAt
    const match = {
      theatre: new mongoose.Types.ObjectId(theatreId),
      createdAt: { $gte: start, $lte: end },
      // include cancelled in table if you want them visible:
      // remove this line if you want ALL:
      // status: { $ne: "CANCELLED" },
    };

    console.log("[THEATRE REPORTS] match =", {
      theatreId: String(theatreId),
      start: start.toISOString(),
      end: end.toISOString(),
    });

    const bookings = await Booking.find(match)
      .sort({ createdAt: -1 })
      .lean();

    // you don't use summary/sales from backend, but we can still send simple ones
    return res.json({
      ok: true,
      theatreId,
      theatreName: req.user.theatreName || null,
      bookings,
    });
  } catch (err) {
    console.error("[GET /api/bookings/theatre/reports] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load theatre reports",
      details:
        process.env.NODE_ENV === "development"
          ? { message: err?.message, stack: err?.stack }
          : undefined,
    });
  }
});

export default router;
