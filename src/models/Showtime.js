// models/Showtime.js
import mongoose from "mongoose";

const seatSchema = new mongoose.Schema(
  {
    row: Number,
    col: Number,
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
    movie:   { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true, index: true },
    theater: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", required: true, index: true },
    screen:  { type: mongoose.Schema.Types.ObjectId, ref: "Screen", required: true, index: true },
    city:    { type: String }, // optional; we auto-fill below if absent
    startTime:   { type: Date, required: true, index: true },
    basePrice:   { type: Number, required: true },
    dynamicPricing: { type: Boolean, default: false },
    seats: [seatSchema],
    // Kept for backward compat; consider removing once not used anywhere:
    bookedSeats: [{ row: Number, col: Number }],
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* Indexes                                                                    */
/* -------------------------------------------------------------------------- */

// Frequent queries: by theater/date, movie/date, screen/date
showtimeSchema.index({ theater: 1, startTime: 1 });
showtimeSchema.index({ movie: 1, startTime: 1 });
showtimeSchema.index({ screen: 1, startTime: 1 });

// Optional: helpful for city filter (case-sensitive, route uses regex i)
showtimeSchema.index({ city: 1 });

// Soft “no overlap” on same screen within same minute (tune as needed)
showtimeSchema.index(
  { screen: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { startTime: { $type: "date" } } }
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// Initialize seats if empty, using screen rows/cols
showtimeSchema.methods.ensureSeatsInitialized = async function () {
  if (Array.isArray(this.seats) && this.seats.length > 0) return this;
  const Screen = mongoose.model("Screen");
  let rows = 10, cols = 10;

  if (this.screen) {
    const scr = await Screen.findById(this.screen).lean();
    rows = Number(scr?.rows) || rows;
    cols = Number(scr?.cols) || cols;
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

// Auto-fill city from Theater if not set
showtimeSchema.pre("validate", async function (next) {
  if (!this.city && this.theater) {
    const Theater = mongoose.model("Theater");
    const th = await Theater.findById(this.theater).select("city").lean();
    if (th?.city) this.city = th.city;
  }
  next();
});

export default mongoose.model("Showtime", showtimeSchema);
