// backend/src/models/Showtime.js
import mongoose from "mongoose";

const seatSchema = new mongoose.Schema(
  {
    row: { type: Number, required: true },
    col: { type: Number, required: true },
    status: {
      type: String,
      enum: ["AVAILABLE", "LOCKED", "BOOKED"],
      default: "AVAILABLE",
    },
  },
  { _id: false }
);

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

    city: { type: String, trim: true },
    startTime: { type: Date, required: true, index: true },

    basePrice: {
      type: Number,
      required: true,
      min: [1, "Base price must be positive"],
    },

    dynamicPricing: { type: Boolean, default: false },
    seats: [seatSchema],

    // Legacy compatibility: some old data may still use bookedSeats array
    bookedSeats: [{ row: Number, col: Number }],
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* Indexes                                                                    */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* Seat Initialization Helper                                                 */
/* -------------------------------------------------------------------------- */
showtimeSchema.methods.ensureSeatsInitialized = async function () {
  if (Array.isArray(this.seats) && this.seats.length > 0) return this;

  const Screen = mongoose.model("Screen");
  let rows = 10,
    cols = 10;

  if (this.screen) {
    const scr = await Screen.findById(this.screen).lean();
    rows = Number(scr?.rows || 10);
    cols = Number(scr?.cols || 10);
  }

  const seats = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      seats.push({ row: r, col: c, status: "AVAILABLE" });
    }
  }
  this.seats = seats;
  await this.save();
  return this;
};

/* -------------------------------------------------------------------------- */
/* Middleware                                                                 */
/* -------------------------------------------------------------------------- */

// 🔹 Auto-fill missing city from Theater
// 🔹 Auto-fill missing basePrice if not set
// 🔹 Ensure seats are initialized once
showtimeSchema.pre("validate", async function (next) {
  try {
    const Theater = mongoose.model("Theater");
    const Screen = mongoose.model("Screen");

    // Fill city from Theater
    if (!this.city && this.theater) {
      const th = await Theater.findById(this.theater)
        .select("city capacity totalSeats")
        .lean();
      if (th?.city) this.city = th.city;
    }

    // Ensure basePrice is present (fallback from Screen or Theater default)
    if (!this.basePrice || this.basePrice <= 0) {
      if (this.screen) {
        const scr = await Screen.findById(this.screen)
          .select("basePrice")
          .lean();
        if (scr?.basePrice) this.basePrice = scr.basePrice;
      }
    }

    // Fallback to theater-level price if screen had none
    if (!this.basePrice || this.basePrice <= 0) {
      const th = await Theater.findById(this.theater)
        .select("defaultPrice")
        .lean();
      if (th?.defaultPrice) this.basePrice = th.defaultPrice;
      else this.basePrice = 200; // final fallback
    }

    // Initialize seats if missing
    if (!this.seats || this.seats.length === 0) {
      await this.ensureSeatsInitialized();
    }

    next();
  } catch (err) {
    console.warn("[Showtime pre-validate] failed:", err.message);
    next(); // never block save
  }
});

export default mongoose.model("Showtime", showtimeSchema);
