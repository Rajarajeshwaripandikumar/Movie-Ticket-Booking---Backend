// backend/src/models/Showtime.js
import mongoose from "mongoose";
import Booking from "./Booking.js";
import SeatLock from "./SeatLock.js";

/**
 * Seat item inside a showtime.
 * We store seatId (string) to match Screen seatId and Booking.seats[].seatId
 */
const showtimeSeatSchema = new mongoose.Schema(
  {
    seatId: { type: String, required: true }, // e.g. "A1"
    row: { type: String },
    col: { type: Number },
    seatType: { type: String, default: "REGULAR" }, // REGULAR, PREMIUM, VIP...
    price: { type: Number, default: 0 }, // per-seat price in rupees (optional override)
    // status is not persisted as source-of-truth; availability is calculated on demand
  },
  { _id: false }
);

const showtimeSchema = new mongoose.Schema(
  {
    movie: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true, index: true },
    theater: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", required: true, index: true },
    screen: { type: mongoose.Schema.Types.ObjectId, ref: "Screen", required: true, index: true },

    // derived city for quick searching (filled in pre-validate)
    city: { type: String, index: true },

    startTime: { type: Date, required: true, index: true },
    endTime: { type: Date, required: false, index: true },

    // duration (minutes) — if provided, endTime will be computed
    durationMins: { type: Number, required: false },

    // basePrice is a fallback; prices per seat type are preferred
    basePrice: { type: Number, required: true },

    // Pricing overrides for this showtime: [{ seatType: 'VIP', price: 450 }]
    pricingOverrides: [
      {
        seatType: String,
        price: Number,
      },
    ],

    // Seat map snapshot for the showtime, created from Screen.seats
    seats: {
      type: [showtimeSeatSchema],
      default: [],
    },

    // small legacy compatibility field (not authoritative)
    bookedSeats: [{ seatId: String }],

    isCancelled: { type: Boolean, default: false },

    // optional metadata
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

/* ----------------------------- Indexes ----------------------------------- */

// Frequent queries: by theater/date, movie/date, screen/date
showtimeSchema.index({ theater: 1, startTime: 1 });
showtimeSchema.index({ movie: 1, startTime: 1 });
showtimeSchema.index({ screen: 1, startTime: 1 });

/* ----------------------------- Helpers ----------------------------------- */

/**
 * Compute endTime if durationMins provided and endTime not set.
 */
showtimeSchema.pre("validate", async function (next) {
  try {
    if (!this.endTime && this.durationMins) {
      this.endTime = new Date(new Date(this.startTime).getTime() + this.durationMins * 60000);
    }
    // Auto-fill city if missing
    if (!this.city && this.theater) {
      const Theater = mongoose.model("Theater");
      const th = await Theater.findById(this.theater).select("city").lean();
      if (th?.city) this.city = th.city;
    }
    next();
  } catch (err) {
    next(err);
  }
});

/* -------------------------- Instance Methods ----------------------------- */

/**
 * Ensure seats are initialized for this showtime.
 * Preferred source: Screen.seats (full layout). If that's absent, fallback to rows/cols style generation.
 *
 * If seats already exist, this is a no-op.
 */
showtimeSchema.methods.ensureSeatsInitialized = async function () {
  if (Array.isArray(this.seats) && this.seats.length > 0) return this;

  const Screen = mongoose.model("Screen");
  const scr = await Screen.findById(this.screen).lean();
  if (!scr) {
    // fallback: create a small grid if screen not found
    const rows = 10;
    const cols = 10;
    const seats = [];
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        seats.push({ seatId: `R${r}C${c}`, row: String(r), col: c, seatType: "REGULAR", price: this.basePrice });
      }
    }
    this.seats = seats;
    await this.save();
    return this;
  }

  // If screen has a detailed seats layout, copy that into showtime seats snapshot
  if (Array.isArray(scr.seats) && scr.seats.length > 0) {
    const seats = scr.seats.map((s) => ({
      seatId: s.seatId,
      row: s.row,
      col: s.col,
      seatType: s.seatType || "REGULAR",
      price: s.price || (this.pricingOverrides?.find(p => p.seatType === s.seatType)?.price) || (scr.pricing?.[s.seatType] ?? this.basePrice),
    }));
    this.seats = seats;
    await this.save();
    return this;
  }

  // As a last resort, use scr.rows/scr.cols if present
  const rows = Number(scr.rows) || 10;
  const cols = Number(scr.cols) || 10;
  const seats = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      seats.push({ seatId: `R${r}C${c}`, row: String(r), col: c, seatType: "REGULAR", price: this.basePrice });
    }
  }
  this.seats = seats;
  await this.save();
  return this;
};

/**
 * Compute availability for seats in this showtime.
 * Does NOT modify DB — returns computed statuses combining:
 *  - confirmed bookings (Booking.status === "CONFIRMED")
 *  - active seat locks (SeatLock.status === "HELD" && lockedUntil > now)
 *
 * Returns array: [{ seatId, seatType, price, availability: 'AVAILABLE'|'LOCKED'|'BOOKED', lockedBy, lockedUntil }]
 */
showtimeSchema.methods.getSeatAvailability = async function () {
  // Ensure seats snapshot exists (but do not force save here — optional)
  if (!Array.isArray(this.seats) || this.seats.length === 0) {
    await this.ensureSeatsInitialized();
  }

  const seatIds = this.seats.map((s) => s.seatId);

  // 1) Query confirmed bookings for this showtime
  const confirmedBookings = await Booking.find({
    showtime: this._id,
    status: "CONFIRMED",
    "seats.seatId": { $in: seatIds },
  }).lean();

  const bookedSeatSet = new Map(); // seatId -> bookingId
  for (const b of confirmedBookings) {
    for (const s of b.seats || []) {
      if (s.seatId) bookedSeatSet.set(s.seatId, b._id.toString());
    }
  }

  // 2) Query active seat locks
  const now = new Date();
  const locks = await SeatLock.find({
    showtime: this._id,
    seat: { $in: seatIds },
    lockedUntil: { $gt: now },
    status: "HELD",
  }).lean();

  const lockMap = new Map(); // seatId -> lock
  for (const l of locks) lockMap.set(l.seat, l);

  // 3) Build availability array
  const result = this.seats.map((s) => {
    const seatId = s.seatId;
    if (bookedSeatSet.has(seatId)) {
      return { seatId, seatType: s.seatType, price: s.price, availability: "BOOKED", bookingId: bookedSeatSet.get(seatId) };
    }
    if (lockMap.has(seatId)) {
      const l = lockMap.get(seatId);
      return { seatId, seatType: s.seatType, price: s.price, availability: "LOCKED", lockedBy: l.lockedBy?.toString?.(), lockedUntil: l.lockedUntil };
    }
    return { seatId, seatType: s.seatType, price: s.price, availability: "AVAILABLE" };
  });

  return result;
};

/* ------------------------- Static / Utility Methods ----------------------- */

/**
 * Check for overlapping showtimes on a screen.
 * Params: screenId, candidateStart (Date), candidateEnd (Date)
 * Returns true if an overlap exists.
 */
showtimeSchema.statics.hasOverlap = async function (screenId, candidateStart, candidateEnd, excludeShowtimeId = null) {
  if (!screenId || !candidateStart || !candidateEnd) return false;

  const filter = {
    screen: screenId,
    $or: [
      // existing starts before candidate end AND existing ends after candidate start => overlap
      { $and: [{ startTime: { $lt: candidateEnd } }, { endTime: { $gt: candidateStart } }] },
      // handle entries with endTime null: treat as overlap if startTime < candidateEnd
      { $and: [{ startTime: { $lt: candidateEnd } }, { endTime: { $exists: false } }] },
    ],
  };
  if (excludeShowtimeId) filter._id = { $ne: excludeShowtimeId };
  const count = await this.countDocuments(filter);
  return count > 0;
};

export default mongoose.model("Showtime", showtimeSchema);
