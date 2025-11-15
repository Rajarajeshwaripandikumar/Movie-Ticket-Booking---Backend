// backend/src/models/Screen.js
import mongoose from "mongoose";

const seatSchema = new mongoose.Schema(
  {
    seatId: { type: String, required: true }, // e.g. "A1", "A2"
    row: { type: String, required: true },    // A, B, C...
    col: { type: Number, required: true },    // column number
    seatType: {
      type: String,
      enum: ["REGULAR", "PREMIUM", "VIP", "RECLINER", "DISABLED"],
      default: "REGULAR",
    },
    price: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false }, // can't be booked
  },
  { _id: false }
);

const screenSchema = new mongoose.Schema(
  {
    theater: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      required: true,
      index: true,
    },

    name: { type: String, required: true },

    // You can still store basic structure, but now optional
    rows: { type: Number, default: 0 },
    cols: { type: Number, default: 0 },

    // 🔥 FULL seat layout
    seats: {
      type: [seatSchema],
      default: [],
    },

    // supports multi-seat types pricing at screen level
    pricing: {
      REGULAR: { type: Number, default: 150 },
      PREMIUM: { type: Number, default: 250 },
      VIP: { type: Number, default: 350 },
      RECLINER: { type: Number, default: 450 },
    },

    // optional screen properties
    screenType: {
      type: String,
      enum: ["2D", "3D", "IMAX", "4DX", "DOLBY"],
      default: "2D",
    },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Unique screen name per theater
screenSchema.index({ theater: 1, name: 1 }, { unique: true });

export default mongoose.model("Screen", screenSchema);
