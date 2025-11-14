// backend/src/models/Showtime.js
import mongoose from "mongoose";
import debugFactory from "debug";

const debug = debugFactory("models:showtime");

/**
 * Showtime Model
 *
 * Responsibilities:
 * - maintain seat grid (rows x cols) with per-seat status
 * - provide helpers for seat label <-> {row,col}
 * - helpers for locking/booking seats with basic atomic checks
 * - auto-fill city & basePrice from related Theater/Screen
 *
 * Backwards-compatible with legacy `bookedSeats` array in older documents.
 */

/* ----------------------------- Sub-schemas ----------------------------- */

const SeatStatuses = ["AVAILABLE", "LOCKED", "BOOKED"];

const seatSchema = new mongoose.Schema(
  {
    row: { type: Number, required: true, min: 1 },
    col: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: SeatStatuses,
      default: "AVAILABLE",
    },
    // optional lock metadata (who locked it, until when)
    lockId: { type: String, default: null }, // e.g., reservation/lock token
    lockUntil: { type: Date, default: null },
  },
  { _id: false }
);

/* ----------------------------- Showtime schema ----------------------------- */

const showtimeSchema = new mongoose.Schema(
  {
    movie: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Movie",
      required: true,
      index: true,
    },
    theater: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      required: true,
      index: true,
    },
    screen: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Screen",
      required: true,
      index: true,
    },

    city: { type: String, trim: true, index: true },
    startTime: { type: Date, required: true, index: true },

    // monetary fields
    basePrice: {
      type: Number,
      required: true,
      min: [0, "Base price must be non-negative"],
      default: 0,
    },
    dynamicPricing: { type: Boolean, default: false },

    // seats grid (array of {row, col, status})
    seats: { type: [seatSchema], default: [] },

    // legacy compatibility: some old data used this
    bookedSeats: [{ row: Number, col: Number }],

    // optional metadata
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

/* ----------------------------- Indexes ----------------------------- */

// search-friendly indexes
showtimeSchema.index({ theater: 1, startTime: 1 });
showtimeSchema.index({ movie: 1, startTime: 1 });
showtimeSchema.index({ screen: 1, startTime: 1 });
showtimeSchema.index({ city: 1 });

// Prevent exact same screen + time duplication
showtimeSchema.index(
  { screen: 1, startTime: 1 },
  {
    unique: true,
    partialFilterExpression: { startTime: { $type: "date" } },
  }
);

/* ----------------------------- Seat helpers ----------------------------- */

/**
 * Convert numeric row -> label: 1 -> A, 26 -> Z, 27 -> AA
 */
function toRowLabel(n) {
  let label = "";
  let x = n;
  while (x > 0) {
    x -= 1;
    label = String.fromCharCode(65 + (x % 26)) + label;
    x = Math.floor(x / 26);
  }
  return label;
}

/**
 * Convert label -> numeric row: A -> 1, Z -> 26, AA -> 27
 */
function fromRowLabel(label) {
  if (!label || typeof label !== "string") return NaN;
  let v = 0;
  for (let i = 0; i < label.length; i++) {
    const ch = label[i].toUpperCase();
    if (ch < "A" || ch > "Z") return NaN;
    v = v * 26 + (ch.charCodeAt(0) - 64);
  }
  return v;
}

/**
 * Build seat labels array like ["A1","A2",...,"B1"...]
 */
function buildSeatLabels(rows, cols) {
  const labels = [];
  for (let r = 1; r <= rows; r++) {
    const rl = toRowLabel(r);
    for (let c = 1; c <= cols; c++) {
      labels.push(`${rl}${c}`);
    }
  }
  return labels;
}

/* ----------------------------- Instance Methods ----------------------------- */

/**
 * Ensure `this.seats` is initialized from `Screen.rows`/`cols` (or fallback 10x10).
 * Returns the document (possibly saved).
 */
showtimeSchema.methods.ensureSeatsInitialized = async function ensureSeatsInitialized() {
  if (Array.isArray(this.seats) && this.seats.length > 0) return this;

  const Screen = mongoose.model("Screen");
  let rows = 10,
    cols = 10;

  try {
    if (this.screen) {
      const scr = await Screen.findById(this.screen).select("rows cols").lean();
      rows = Number(scr?.rows) || rows;
      cols = Number(scr?.cols) || cols;
    }
  } catch (err) {
    debug("[ensureSeatsInitialized] warning: failed to load screen", err?.message || err);
  }

  const seats = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      seats.push({ row: r, col: c, status: "AVAILABLE" });
    }
  }

  this.seats = seats;
  // Do not call save blindly in pre-validate; caller can save.
  await this.save();
  return this;
};

/**
 * Return a simple seat map: { rows, cols, labels: [...], seatsByLabel: {A1: {...}} }
 */
showtimeSchema.methods.getSeatMap = function getSeatMap() {
  const seatsArr = Array.isArray(this.seats) ? this.seats : [];
  // infer rows/cols from seats if possible
  let maxRow = 0,
    maxCol = 0;
  for (const s of seatsArr) {
    if (s.row > maxRow) maxRow = s.row;
    if (s.col > maxCol) maxCol = s.col;
  }
  const rows = maxRow || 0;
  const cols = maxCol || 0;
  const labels = buildSeatLabels(rows, cols);
  const seatsByLabel = {};
  for (const s of seatsArr) {
    const label = `${toRowLabel(s.row)}${s.col}`;
    seatsByLabel[label] = { ...s };
  }
  return { rows, cols, labels, seatsByLabel };
};

/**
 * Find seat index in this.seats for {row,col}
 */
showtimeSchema.methods._findSeatIndex = function _findSeatIndex(row, col) {
  if (!Array.isArray(this.seats)) return -1;
  return this.seats.findIndex((x) => Number(x.row) === Number(row) && Number(x.col) === Number(col));
};

/**
 * Convert seat labels like ["A1","B2"] -> [{row,col}]
 */
showtimeSchema.statics.parseSeatLabels = function parseSeatLabels(labels = []) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((lab) => {
      if (typeof lab !== "string") return null;
      const m = lab.match(/^([A-Za-z]+)(\d+)$/);
      if (!m) return null;
      const row = fromRowLabel(m[1]);
      const col = Number(m[2]);
      if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
      return { row, col };
    })
    .filter(Boolean);
};

/* ----------------------------- Seat state operations ----------------------------- */

/**
 * Try to lock seats atomically in-memory and save.
 * - seatsArg: array of {row,col} or ["A1","B2"]
 * - lockId: string (token)
 * - ttlMs: optional lock TTL in milliseconds
 *
 * Returns { ok: true, locked: [{row,col,label}], failed: [{row,col,label,reason}] }
 */
showtimeSchema.methods.lockSeats = async function lockSeats(seatsArg = [], lockId = null, ttlMs = 120000) {
  if (!seatsArg || seatsArg.length === 0) return { ok: false, locked: [], failed: [] };
  const seatsToLock = Array.isArray(seatsArg) && typeof seatsArg[0] === "string"
    ? this.constructor.parseSeatLabels(seatsArg)
    : seatsArg.map((s) => ({ row: Number(s.row), col: Number(s.col) }));

  const now = new Date();
  const lockUntil = ttlMs ? new Date(now.getTime() + Number(ttlMs)) : null;

  const locked = [];
  const failed = [];

  // refresh lock expiry: first clean expired locks
  if (Array.isArray(this.seats)) {
    for (const s of this.seats) {
      if (s.lockUntil && new Date(s.lockUntil) < now) {
        s.lockUntil = null;
        s.lockId = null;
        if (s.status === "LOCKED") s.status = "AVAILABLE";
      }
    }
  }

  for (const target of seatsToLock) {
    const idx = this._findSeatIndex(target.row, target.col);
    const label = `${toRowLabel(target.row)}${target.col}`;
    if (idx === -1) {
      failed.push({ row: target.row, col: target.col, label, reason: "not_found" });
      continue;
    }
    const seat = this.seats[idx];
    if (seat.status === "BOOKED") {
      failed.push({ row: target.row, col: target.col, label, reason: "already_booked" });
      continue;
    }
    if (seat.status === "LOCKED" && seat.lockId && seat.lockId !== lockId) {
      failed.push({ row: target.row, col: target.col, label, reason: "locked_by_other" });
      continue;
    }

    // lock it
    seat.status = "LOCKED";
    seat.lockId = lockId || `lock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    seat.lockUntil = lockUntil;
    locked.push({ row: target.row, col: target.col, label });
  }

  await this.save();
  return { ok: locked.length > 0 && failed.length === 0, locked, failed };
};

/**
 * Unlock seats by lockId (or unlock specific coordinates).
 * - seatsArg optional: array of {row,col} or ["A1","B2"]
 * - lockId optional: only unlock seats with this lockId if provided
 * Returns unlocked list.
 */
showtimeSchema.methods.unlockSeats = async function unlockSeats(seatsArg = null, lockId = null) {
  const toUnlock = seatsArg
    ? (typeof seatsArg[0] === "string" ? this.constructor.parseSeatLabels(seatsArg) : seatsArg.map(s => ({ row: Number(s.row), col: Number(s.col) })))
    : null;

  const unlocked = [];

  if (!Array.isArray(this.seats)) return { unlocked: [] };

  for (let i = 0; i < this.seats.length; i++) {
    const s = this.seats[i];
    const should = (() => {
      if (toUnlock) {
        return toUnlock.some((t) => Number(t.row) === Number(s.row) && Number(t.col) === Number(s.col));
      }
      if (lockId) {
        return s.lockId && s.lockId === lockId;
      }
      // no args: unlock all expired locks only (no full unlock)
      return false;
    })();
    if (should) {
      if (s.status === "LOCKED") {
        s.status = "AVAILABLE";
      }
      s.lockId = null;
      s.lockUntil = null;
      unlocked.push({ row: s.row, col: s.col });
    }
  }

  await this.save();
  return { unlocked };
};

/**
 * Book seats (finalize). Expects seats to be currently LOCKED by the provided lockId,
 * or optionally allows booking available seats (not recommended without lock).
 * - seatsArg: array of labels or coordinates
 * - lockId: required to ensure atomic behavior
 * Returns { ok, booked, failed }
 */
showtimeSchema.methods.bookSeats = async function bookSeats(seatsArg = [], lockId = null) {
  if (!seatsArg || seatsArg.length === 0) return { ok: false, booked: [], failed: [] };
  if (!lockId) throw new Error("bookSeats requires a lockId to prevent race conditions");

  const targets = typeof seatsArg[0] === "string" ? this.constructor.parseSeatLabels(seatsArg) : seatsArg.map(s => ({ row: Number(s.row), col: Number(s.col) }));

  const booked = [];
  const failed = [];

  // clean expired locks first
  const now = new Date();
  for (const s of this.seats) {
    if (s.lockUntil && new Date(s.lockUntil) < now) {
      s.lockUntil = null;
      s.lockId = null;
      if (s.status === "LOCKED") s.status = "AVAILABLE";
    }
  }

  for (const t of targets) {
    const idx = this._findSeatIndex(t.row, t.col);
    const label = `${toRowLabel(t.row)}${t.col}`;
    if (idx === -1) {
      failed.push({ row: t.row, col: t.col, label, reason: "not_found" });
      continue;
    }
    const s = this.seats[idx];
    if (s.status === "BOOKED") {
      failed.push({ row: t.row, col: t.col, label, reason: "already_booked" });
      continue;
    }
    // ensure lock ownership
    if (s.status === "LOCKED") {
      if (!s.lockId || s.lockId !== lockId) {
        failed.push({ row: t.row, col: t.col, label, reason: "locked_by_other" });
        continue;
      }
    } else {
      // not locked: disallow booking without lock
      failed.push({ row: t.row, col: t.col, label, reason: "not_locked" });
      continue;
    }

    // mark booked
    s.status = "BOOKED";
    s.lockId = null;
    s.lockUntil = null;
    booked.push({ row: t.row, col: t.col, label });
  }

  // Update legacy bookedSeats for compatibility
  if (booked.length > 0) {
    this.bookedSeats = Array.isArray(this.bookedSeats) ? this.bookedSeats.concat(booked.map(b => ({ row: b.row, col: b.col }))) : booked.map(b => ({ row: b.row, col: b.col }));
  }

  await this.save();
  return { ok: booked.length > 0 && failed.length === 0, booked, failed };
};

/* ----------------------------- Static helpers ----------------------------- */

/**
 * Create a showtime and ensure seats initialized.
 * Performs basic consistency checks (screen belongs to theater).
 * Options: { ensureSeats: true }
 */
showtimeSchema.statics.createShowtimeWithSeats = async function createShowtimeWithSeats(payload = {}, options = { ensureSeats: true }) {
  const Theater = mongoose.model("Theater");
  const Screen = mongoose.model("Screen");

  if (!payload || !payload.theater || !payload.screen || !payload.movie || !payload.startTime) {
    throw new Error("Missing required fields: theater, screen, movie, startTime");
  }

  // validate theater / screen consistency if possible
  const [th, scr] = await Promise.all([
    Theater.findById(payload.theater).select("_id").lean(),
    Screen.findById(payload.screen).select("_id theater rows cols basePrice").lean(),
  ]);
  if (!th) throw new Error("Theater not found");
  if (!scr) throw new Error("Screen not found");
  // if screen has theater reference, ensure it matches
  if (scr.theater && String(scr.theater) !== String(payload.theater)) {
    throw new Error("Screen does not belong to provided Theater");
  }

  // prefer provided basePrice, else screen.basePrice, else theater.defaultPrice
  if ((!payload.basePrice || payload.basePrice <= 0) && scr.basePrice) {
    payload.basePrice = scr.basePrice;
  }

  const doc = new this(payload);
  if (options.ensureSeats) {
    await doc.ensureSeatsInitialized();
  } else {
    await doc.save();
  }
  return doc;
};

/* ----------------------------- Middleware ----------------------------- */

/**
 * pre-validate: auto-fill city & basePrice and ensure seats exist.
 * non-blocking and defensive — any error will be logged and won't prevent the save.
 */
showtimeSchema.pre("validate", async function preValidate(next) {
  try {
    const Theater = mongoose.model("Theater");
    const Screen = mongoose.model("Screen");

    // Fill city from Theater if missing
    if (!this.city && this.theater) {
      try {
        const th = await Theater.findById(this.theater).select("city").lean();
        if (th?.city) this.city = th.city;
      } catch (err) {
        debug("[preValidate] failed to load theater:", err?.message || err);
      }
    }

    // Ensure basePrice is present (fallback from Screen then Theater)
    if (!this.basePrice || this.basePrice <= 0) {
      try {
        if (this.screen) {
          const scr = await Screen.findById(this.screen).select("basePrice").lean();
          if (scr?.basePrice) this.basePrice = scr.basePrice;
        }
      } catch (err) {
        debug("[preValidate] failed to load screen for basePrice:", err?.message || err);
      }
    }

    if (!this.basePrice || this.basePrice <= 0) {
      try {
        const th = await Theater.findById(this.theater).select("defaultPrice").lean();
        if (th?.defaultPrice) this.basePrice = th.defaultPrice;
      } catch (err) {
        debug("[preValidate] failed to load theater for defaultPrice:", err?.message || err);
      }
    }

    // final fallback to reasonable default
    if (!this.basePrice || this.basePrice <= 0) {
      this.basePrice = 200;
    }

    // Seats: only initialize if not present. ensureSeatsInitialized() will call save(),
    // but we avoid double-saving here by only invoking when seats empty.
    if (!Array.isArray(this.seats) || this.seats.length === 0) {
      // ensureSeatsInitialized saves the document itself
      // but we want to continue validation even if this fails.
      try {
        await this.ensureSeatsInitialized();
      } catch (err) {
        debug("[preValidate] ensureSeatsInitialized failed:", err?.message || err);
      }
    }

    next();
  } catch (err) {
    debug("[preValidate] unexpected error:", err?.message || err);
    next();
  }
});

/* ----------------------------- Post hooks / events ----------------------------- */

/**
 * Optional: notify listeners on delete. Keep light-weight: do not implement heavy cascading here.
 * If you need cascade delete of related ShowReservations / Bookings, implement it in a dedicated service
 * or a transaction-aware job.
 */
showtimeSchema.post("findOneAndDelete", async function (doc) {
  try {
    if (!doc) return;
    // Example event emission pattern for your app to pick up (replace with your real event bus)
    // process.nextTick(() => someEventBus.emit("showtime:deleted", { id: doc._id }));
    debug("Showtime deleted:", String(doc._id));
  } catch (err) {
    debug("[post delete] error:", err?.message || err);
  }
});

/* ----------------------------- Export ----------------------------- */

const Showtime = mongoose.models.Showtime || mongoose.model("Showtime", showtimeSchema);
export default Showtime;
