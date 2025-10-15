// models/SeatLock.js
import mongoose from "mongoose";

const seatLockSchema = new mongoose.Schema(
  {
    showtime: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Showtime",
      index: true,
      required: true,
    },

    seat: {
      type: String,
      required: true, // e.g. "A1" or "8-1" — use consistent format
    },

    lockedBy: {
      type: mongoose.Schema.Types.ObjectId, // or String if you allow anonymous holds
      ref: "User",
      required: true,
    },

    status: {
      type: String,
      enum: ["HELD", "USED", "RELEASED"],
      default: "HELD",
      index: true,
    },

    lockedUntil: {
      type: Date,
      required: true,
      index: true, // TTL below
    },
  },
  { timestamps: true }
);

// Prevent multiple locks for the same seat in a showtime
seatLockSchema.index({ showtime: 1, seat: 1 }, { unique: true });

// MongoDB TTL cleanup: automatically removes expired locks
// Docs are deleted once current time > lockedUntil
seatLockSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0 });

// Utility: check if lock is still valid
seatLockSchema.methods.isActive = function () {
  return this.status === "HELD" && this.lockedUntil > new Date();
};

export default mongoose.model("SeatLock", seatLockSchema);
