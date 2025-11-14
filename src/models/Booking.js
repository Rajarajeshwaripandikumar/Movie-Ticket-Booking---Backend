// backend/src/models/Booking.js
import mongoose from "mongoose";
import Showtime from "./Showtime.js";
import Screen from "./Screen.js";

/* -------------------- Seat helpers (kept local) -------------------- */

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
  // return with hyphen (e.g. H-7) so display is consistent
  if (!row || !col) return String(`${row ?? ""}${col ?? ""}`).trim();
  return `${rowToLabel(row)}-${col}`;
}

function expandRangeString(s) {
  if (!s || typeof s !== "string") return [];
  s = s.trim();
  if (s.includes(",")) return s.split(",").map((p) => p.trim()).flatMap(expandRangeString);

  if (/^\d+\s*-\s*\d+$/.test(s)) {
    const [a, b] = s.split("-").map((x) => parseInt(x.trim(), 10)).sort((x, y) => x - y);
    if (Number.isFinite(a) && Number.isFinite(b)) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }

  if (/^\d+$/.test(s)) return [Number(s)];

  if (/^[A-Za-z]+\s*[-_\s]?\s*\d+$/.test(s) || /^[A-Za-z]+\d+$/.test(s)) {
    const parts = s.split(/[-_\s]+/).filter(Boolean);
    return [`${parts[0].toUpperCase()}-${parts[1]}`];
  }

  return [s];
}

function numericIdToRowCol(id, seatsPerRow) {
  if (!Number.isFinite(id) || !Number.isInteger(id) || !seatsPerRow) return null;
  const idx = id - 1;
  const row = Math.floor(idx / seatsPerRow) + 1;
  const col = (idx % seatsPerRow) + 1;
  return { row, col };
}

function normalizeSeatsRaw(rawSeats, seatsPerRow = 10) {
  if (rawSeats == null) return [];
  let arr = Array.isArray(rawSeats) ? rawSeats.slice() : expandRangeString(String(rawSeats));
  const out = [];

  for (const token of arr) {
    if (token == null) continue;

    // object shape {row, col, label}
    if (typeof token === "object" && !Array.isArray(token)) {
      const r = Number(token.row);
      const c = Number(token.col);
      if (Number.isFinite(r) && Number.isFinite(c)) {
        out.push({ row: r, col: c, label: token.label || seatLabel(r, c) });
      } else if (token.label) {
        out.push({ row: null, col: null, label: String(token.label) });
      } else {
        out.push({ row: null, col: null, label: String(token) });
      }
      continue;
    }

    // numeric token (global seat id)
    if (typeof token === "number") {
      const rc = numericIdToRowCol(token, seatsPerRow);
      if (rc) out.push({ row: rc.row, col: rc.col, label: seatLabel(rc.row, rc.col) });
      else out.push({ row: null, col: null, label: String(token) });
      continue;
    }

    // string token
    if (typeof token === "string") {
      const t = token.trim();
      if (/^[A-Za-z]+-\d+$/.test(t)) {
        const parts = t.split("-");
        const colNum = parseInt(parts[1], 10);
        // keep original letter label (H-7) but store numeric col if parseable
        out.push({ row: null, col: Number.isFinite(colNum) ? colNum : null, label: t.toUpperCase() });
      } else if (/^\d+$/.test(t)) {
        const id = parseInt(t, 10);
        const rc = numericIdToRowCol(id, seatsPerRow);
        if (rc) out.push({ row: rc.row, col: rc.col, label: seatLabel(rc.row, rc.col) });
        else out.push({ row: null, col: null, label: t });
      } else {
        out.push({ row: null, col: null, label: t });
      }
      continue;
    }

    out.push({ row: null, col: null, label: String(token) });
  }

  return out;
}

/* --------------------------- Mongoose schema --------------------------- */

const SeatSchema = new mongoose.Schema(
  {
    row: { type: Number, required: false },
    col: { type: Number, required: false },
    label: { type: String, required: false },
  },
  { _id: false }
);

const bookingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    showtime: { type: mongoose.Schema.Types.ObjectId, ref: "Showtime", required: true },

    // NEW: explicit movie ref so future bookings won't end up undefined
    movie: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: false, index: true },

    seats: { type: [SeatSchema], default: [] },
    amount: { type: Number, default: 0 },
    status: { type: String, enum: ["CONFIRMED", "CANCELLED"], default: "CONFIRMED" },
  },
  { timestamps: true }
);

// indexes for common queries
bookingSchema.index({ showtime: 1 });
bookingSchema.index({ user: 1 });

/* ------------------------- pre-validate normalization ------------------------ */
/*
  On validate we:
   - backfill booking.movie from showtime.movie (if available)
   - set amount from showtime.basePrice when missing
   - normalize seats into array of {row, col, label} using screen.cols when available
*/
bookingSchema.pre("validate", async function (next) {
  try {
    let seatsPerRow = 10;

    if (this.showtime) {
      try {
        const show = await Showtime.findById(this.showtime).select("movie screen basePrice").lean();
        if (show) {
          // backfill movie if missing
          if (!this.movie && show.movie) {
            // allow strings/objectIds — mongoose will cast when saving
            this.movie = show.movie;
          }

          // use show.basePrice to set amount if not provided or zero
          if ((!this.amount || this.amount === 0) && typeof show.basePrice === "number") {
            // seats length might be unnormalized yet; use provided seats length or 1
            const seatCount = Array.isArray(this.seats) && this.seats.length > 0 ? this.seats.length : 1;
            this.amount = Number(show.basePrice) * seatCount;
          }

          // derive seatsPerRow from show.screen
          if (show.screen) {
            try {
              const screen = await Screen.findById(show.screen).select("cols").lean();
              seatsPerRow = Number(screen?.cols || seatsPerRow);
            } catch (e) {
              seatsPerRow = 10;
            }
          }
        } else {
          // showtime not found — fall back to defaults
          seatsPerRow = 10;
        }
      } catch (err) {
        // non-fatal: fallback to defaults
        seatsPerRow = 10;
      }
    }

    // Only normalize seats if any element is not already an object with label/row/col
    const needNormalize =
      !Array.isArray(this.seats) ||
      this.seats.length === 0 ||
      this.seats.some(
        (s) =>
          s == null ||
          typeof s !== "object" ||
          (!("label" in s) && !("row" in s && "col" in s))
      );

    if (needNormalize) {
      this.seats = normalizeSeatsRaw(this.seats || [], seatsPerRow);
    } else {
      // ensure label present for each seat and normalize label formatting
      this.seats = this.seats.map((s) => {
        if (!s) return s;
        const r = Number(s.row);
        const c = Number(s.col);
        if (Number.isFinite(r) && Number.isFinite(c)) {
          return { row: r, col: c, label: s.label || seatLabel(r, c) };
        }
        // if row/col are not numeric, prefer existing label, otherwise construct fallback
        const existingLabel = s.label ?? null;
        if (existingLabel) return { row: s.row ?? null, col: s.col ?? null, label: String(existingLabel) };
        // fallback to `${row}-${col}` but ensure row is converted to letter when numeric-like
        if (s.row != null && s.col != null) {
          const rn = Number(s.row);
          const cn = Number(s.col);
          if (Number.isFinite(rn) && Number.isFinite(cn)) {
            return { row: rn, col: cn, label: seatLabel(rn, cn) };
          }
        }
        return { row: s.row ?? null, col: s.col ?? null, label: String(`${s.row ?? ""}-${s.col ?? ""}`).replace(/^-|-$|^$/, "").trim() };
      });
    }

    return next();
  } catch (err) {
    // if normalization/backfill fails, don't block save — best-effort only
    console.warn("Booking pre-validate normalization failed:", err);
    return next();
  }
});

const Booking = mongoose.models?.Booking || mongoose.model("Booking", bookingSchema);
export default Booking;
