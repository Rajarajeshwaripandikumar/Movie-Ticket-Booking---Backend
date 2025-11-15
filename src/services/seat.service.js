// backend/src/services/seatLock.service.js
import mongoose from "mongoose";
import SeatLock from "../models/SeatLock.js";
import Showtime from "../models/Showtime.js";
import Booking from "../models/Booking.js";

const LOCK_MINUTES = parseInt(process.env.SEAT_LOCK_MINUTES || "10", 10);

/**
 * Canonical seat id: "ROW:COL" where ROW and COL are integers (1-based)
 * Examples accepted:
 *  - "A1", "a1", "A-1", "a_1" -> converted using letter->row mapping (A=1, B=2, ... AA=27)
 *  - "1:1", "1-1", "1_1" -> numeric
 *  - { row: 1, col: 1 } -> numeric
 *  - "R1C1" (not required, but will fallback to numeric parsing if present)
 */
function lettersToNumber(letters) {
  if (!letters) return NaN;
  const s = String(letters).toUpperCase().replace(/[^A-Z]/g, "");
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64); // A -> 1
  }
  return n;
}

function normalizeSeat(seat) {
  if (!seat && seat !== 0) return null;

  // object form {row, col}
  if (typeof seat === "object" && seat !== null) {
    const r = Number(seat.row);
    const c = Number(seat.col ?? seat.column ?? seat.colIndex);
    if (Number.isFinite(r) && Number.isFinite(c)) return `${Math.floor(r)}:${Math.floor(c)}`;
    // fallback to string conversion
    return String(seat).trim().toUpperCase();
  }

  // string form
  if (typeof seat === "string") {
    const s = seat.trim();

    // already in numeric "r:c" or "r-c" or "r_c"
    const mNum = s.match(/^(\d+)[\s:_-]?(\d+)$/);
    if (mNum) {
      return `${parseInt(mNum[1], 10)}:${parseInt(mNum[2], 10)}`;
    }

    // letter+number forms like A1, AA12, A-1, a_12
    const mLabel = s.match(/^([A-Za-z]+)[\s_-]*([0-9]+)$/);
    if (mLabel) {
      const row = lettersToNumber(mLabel[1]);
      const col = parseInt(mLabel[2], 10);
      if (Number.isFinite(row) && Number.isFinite(col)) return `${row}:${col}`;
    }

    // fallback: try to see "R1C1" pattern
    const mR = s.match(/r\s*?(\d+)\s*?c\s*?(\d+)/i);
    if (mR) return `${parseInt(mR[1], 10)}:${parseInt(mR[2], 10)}`;

    // as last resort, return trimmed uppercase (legacy compatibility)
    return s.toUpperCase();
  }

  // other primitive types (number)
  if (typeof seat === "number") return String(seat);

  return String(seat).trim();
}

/* -------------------------------------------------------------------------- */
/*             Get ALL seats unavailable (booked + paid + locked)             */
/* -------------------------------------------------------------------------- */
export async function getUnavailableSeats(showtimeId) {
  if (!showtimeId) throw new Error("showtimeId required");

  const stId = mongoose.Types.ObjectId.isValid(String(showtimeId))
    ? new mongoose.Types.ObjectId(String(showtimeId))
    : null;
  if (!stId) throw new Error("Invalid showtimeId");

  const showtime = await Showtime.findById(stId).select("seats").lean();
  if (!showtime) throw new Error("Showtime not found");

  const now = new Date();

  // Active locks
  const locksPromise = SeatLock.find({
    showtime: stId,
    lockedUntil: { $gt: now },
  })
    .select("seat")
    .lean();

  // Confirmed bookings for this showtime (assumes Booking.seats is array of seat strings/objects)
  const bookingsPromise = Booking.find(
    { showtime: stId, status: "CONFIRMED" },
    { seats: 1, _id: 0 }
  ).lean();

  const [locks, confirmedBookings] = await Promise.all([locksPromise, bookingsPromise]);

  // seats marked BOOKED in showtime.seats (if present)
  const stBooked = Array.isArray(showtime.seats)
    ? showtime.seats
        .filter((s) => s && (s.status === "BOOKED" || s.status === "SOLD"))
        .map((s) => {
          // support seat objects {row,col} or stored keys
          if (s.row != null && s.col != null) return normalizeSeat({ row: s.row, col: s.col });
          if (s.seat) return normalizeSeat(s.seat);
          return normalizeSeat(s);
        })
    : [];

  const lockedSeats = (locks || []).map((l) => normalizeSeat(l.seat));
  const bookedSeats = (confirmedBookings || []).flatMap((b) =>
    (b.seats || []).map((s) => normalizeSeat(s))
  );

  const all = new Set([...stBooked, ...bookedSeats, ...lockedSeats].filter(Boolean));
  return all;
}

/* -------------------------------------------------------------------------- */
/*                   Atomic seat lock (no race condition)                     */
/* -------------------------------------------------------------------------- */
export async function lockSeats({ showtimeId, seats = [], userId }) {
  if (!showtimeId) throw new Error("showtimeId required");
  if (!Array.isArray(seats) || seats.length === 0) {
    return { ok: false, conflicts: [], error: "seats array required" };
  }
  if (!userId) return { ok: false, conflicts: [], error: "userId required" };

  const stId = mongoose.Types.ObjectId.isValid(String(showtimeId))
    ? new mongoose.Types.ObjectId(String(showtimeId))
    : null;
  if (!stId) return { ok: false, conflicts: [], error: "invalid showtimeId" };

  const normalizedSeats = seats.map(normalizeSeat).filter(Boolean);

  // STEP 1: Conflict check before attempting write
  const unavailable = await getUnavailableSeats(stId);
  const conflictsBefore = normalizedSeats.filter((s) => unavailable.has(s));
  if (conflictsBefore.length > 0) {
    return { ok: false, conflicts: conflictsBefore };
  }

  // STEP 2: Atomic locking operation — try upserting locks where seat is free or expired
  const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);

  try {
    const ops = normalizedSeats.map((seat) => ({
      updateOne: {
        filter: {
          showtime: stId,
          seat,
          // either no lock exists, or existing lock expired, or lockedBy is the same user (renew)
          $or: [{ lockedUntil: { $lt: new Date() } }, { lockedBy: userId }],
        },
        update: {
          $set: {
            showtime: stId,
            seat,
            lockedBy: userId,
            lockedUntil,
          },
        },
        upsert: true,
      },
    }));

    // unordered so failure on one doesn't stop others; still we re-check afterwards
    await SeatLock.bulkWrite(ops, { ordered: false });

    // STEP 3: Re-check — detect any seat now locked by others
    const stillConflicting = await SeatLock.find({
      showtime: stId,
      seat: { $in: normalizedSeats },
      lockedUntil: { $gt: new Date() },
      lockedBy: { $ne: userId },
    })
      .select("seat lockedBy lockedUntil")
      .lean();

    if (stillConflicting.length > 0) {
      return {
        ok: false,
        conflicts: stillConflicting.map((x) => normalizeSeat(x.seat)),
      };
    }

    // Success
    return { ok: true, lockedUntil, seats: normalizedSeats };
  } catch (err) {
    console.error("[seatLock] bulkWrite error:", err);
    return { ok: false, conflicts: normalizedSeats, error: String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Release seats                                 */
/* -------------------------------------------------------------------------- */
export async function releaseSeats({ showtimeId, seats = [], userId }) {
  if (!showtimeId) throw new Error("showtimeId required");
  if (!Array.isArray(seats) || seats.length === 0) return { ok: false, error: "seats array required" };

  const stId = mongoose.Types.ObjectId.isValid(String(showtimeId))
    ? new mongoose.Types.ObjectId(String(showtimeId))
    : null;
  if (!stId) return { ok: false, error: "invalid showtimeId" };

  const normalized = seats.map(normalizeSeat).filter(Boolean);

  // allow releasing only seats locked by this user (safer). If you need super-release, add admin check elsewhere.
  await SeatLock.deleteMany({
    showtime: stId,
    seat: { $in: normalized },
    lockedBy: userId,
  });

  return { ok: true };
}
