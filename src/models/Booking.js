// src/models/Booking.js
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
  if (!row || !col) return String(`${row ?? ""}${col ?? ""}`).trim();
  return `${rowToLabel(row)}${col}`;
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
    seats: { type: [SeatSchema], default: [] },
    amount: Number,
    status: { type: String, enum: ["CONFIRMED", "CANCELLED"], default: "CONFIRMED" },
  },
  { timestamps: true }
);

/* ------------------------- pre-save normalization ------------------------ */
/*
  On save we normalize `seats` into array of {row, col, label}.
  We try to look up showtime -> screen to get `cols` (seatsPerRow) for numeric ID translation.
  If anything fails we fall back to 10 columns.
*/
bookingSchema.pre("save", async function (next) {
  try {
    let seatsPerRow = 10;
    try {
      if (this.showtime) {
        const show = await Showtime.findById(this.showtime).select("screen").lean();
        if (show?.screen) {
          const screen = await Screen.findById(show.screen).select("cols").lean();
          seatsPerRow = Number(screen?.cols || seatsPerRow);
        }
      }
    } catch (err) {
      // non-fatal: fallback to default seatsPerRow
      seatsPerRow = 10;
    }

    // Only normalize if seats is not already objects with label/row/col
    const needNormalize =
      !Array.isArray(this.seats) ||
      this.seats.length === 0 ||
      !(typeof this.seats[0] === "object" && ("label" in this.seats[0] || ("row" in this.seats[0] && "col" in this.seats[0])));

    if (needNormalize) {
      this.seats = normalizeSeatsRaw(this.seats || [], seatsPerRow);
    } else {
      // ensure label present for each seat
      this.seats = this.seats.map((s) => {
        if (!s) return s;
        const r = Number(s.row);
        const c = Number(s.col);
        if (Number.isFinite(r) && Number.isFinite(c)) {
          return { row: r, col: c, label: s.label || seatLabel(r, c) };
        }
        return { row: s.row ?? null, col: s.col ?? null, label: s.label ?? String(s.label ?? `${s.row ?? ""}-${s.col ?? ""}`) };
      });
    }
    next();
  } catch (err) {
    // if normalization fails, don't block save — best-effort only
    console.warn("Booking pre-save normalization failed:", err);
    next();
  }
});

export default mongoose.model("Booking", bookingSchema);
