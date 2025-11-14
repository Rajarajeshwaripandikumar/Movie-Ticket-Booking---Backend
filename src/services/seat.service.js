// backend/src/services/seatLock.service.js
import SeatLock from "../models/SeatLock.js";
import Showtime from "../models/Showtime.js";
import Booking from "../models/Booking.js";

const LOCK_MINUTES = parseInt(process.env.SEAT_LOCK_MINUTES || "10", 10);

/* -------------------------------------------------------------------------- */
/* normalize seat ID (Seat A1, a1, "A-1", obj → "A1")                         */
/* -------------------------------------------------------------------------- */
function normalizeSeat(seat) {
  if (!seat) return null;

  if (typeof seat === "string") {
    return seat.replace(/[-_\s]/g, "").toUpperCase().trim();
  }

  if (typeof seat === "object" && seat.row != null && seat.col != null) {
    return `${String(seat.row).toUpperCase()}${String(seat.col).toUpperCase()}`;
  }

  return String(seat).toUpperCase().trim();
}

/* -------------------------------------------------------------------------- */
/*             Get ALL seats unavailable (booked + paid + locked)             */
/* -------------------------------------------------------------------------- */
export async function getUnavailableSeats(showtimeId) {
  const st = await Showtime.findById(showtimeId)
    .select("bookedSeats")
    .lean();

  if (!st) throw new Error("Showtime not found");

  const now = new Date();

  const [locks, confirmed] = await Promise.all([
    SeatLock.find({
      showtime: showtimeId,
      lockedUntil: { $gt: now },
    }).lean(),

    Booking.find(
      { showtime: showtimeId, status: "CONFIRMED" },
      { seats: 1, _id: 0 }
    ).lean(),
  ]);

  const stBooked = (st.bookedSeats || []).map(normalizeSeat);
  const lockedSeats = locks.map((l) => normalizeSeat(l.seat));
  const bookedSeats = confirmed.flatMap((b) => b.seats.map(normalizeSeat));

  return new Set([...stBooked, ...bookedSeats, ...lockedSeats]);
}

/* -------------------------------------------------------------------------- */
/*                   Atomic seat lock (no race condition)                     */
/* -------------------------------------------------------------------------- */
export async function lockSeats({ showtimeId, seats, userId }) {
  const normalizedSeats = seats.map(normalizeSeat);

  // STEP 1: Conflict check before attempting write
  const unavailable = await getUnavailableSeats(showtimeId);
  const conflicts = normalizedSeats.filter((s) => unavailable.has(s));

  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }

  // STEP 2: Atomic locking operation — each seat tries to insert atomically
  const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);

  try {
    const ops = normalizedSeats.map((seat) => ({
      updateOne: {
        filter: {
          showtime: showtimeId,
          seat,
          lockedUntil: { $lt: new Date() }, // seat is free OR expired
        },
        update: {
          $set: {
            showtime: showtimeId,
            seat,
            lockedBy: userId,
            lockedUntil,
          },
        },
        upsert: true,
      },
    }));

    const res = await SeatLock.bulkWrite(ops, { ordered: false });

    // STEP 3: Re-check — if any seat failed to lock (matchedCount = 0 and upsert skipped)
    const failed = [];
    normalizedSeats.forEach((s) => {
      const seatDoc = res.getWriteOperationResult
        ? null
        : null; // bulkWrite outputs are not seat-specific; check by querying DB
    });

    // Validation query to detect any lock failures
    const stillConflicting = await SeatLock.find({
      showtime: showtimeId,
      seat: { $in: normalizedSeats },
      lockedUntil: { $gt: new Date() },
      lockedBy: { $ne: userId },
    }).lean();

    if (stillConflicting.length > 0) {
      return {
        ok: false,
        conflicts: stillConflicting.map((x) => normalizeSeat(x.seat)),
      };
    }

    return { ok: true, lockedUntil };
  } catch (err) {
    console.error("[seatLock] bulkWrite error:", err);
    return { ok: false, conflicts: normalizedSeats };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Release seats                                 */
/* -------------------------------------------------------------------------- */
export async function releaseSeats({ showtimeId, seats, userId }) {
  const normalized = seats.map(normalizeSeat);

  await SeatLock.deleteMany({
    showtime: showtimeId,
    seat: { $in: normalized },
    lockedBy: userId,
  });

  return { ok: true };
}
