// models/SeatLock.js
import mongoose from "mongoose";

const seatLockSchema = new mongoose.Schema(
  {
    showtime: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Showtime",
      required: true,
      index: true,
    },

    // Always normalized seat ID (A1, B10, etc.)
    seat: {
      type: String,
      required: true,
      index: true,
    },

    // User who locked it
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
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
      index: true, // TTL cleanup
    },
  },
  {
    timestamps: true,
  }
);

/* -------------------------------------------------------------------------- */
/* UNIQUE INDEX: One lock per seat per showtime                               */
/* -------------------------------------------------------------------------- */
seatLockSchema.index(
  { showtime: 1, seat: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["HELD", "USED"] },
    },
  }
);

/* -------------------------------------------------------------------------- */
/* TTL INDEX: auto delete expired locks                                       */
/* -------------------------------------------------------------------------- */
seatLockSchema.index(
  { lockedUntil: 1 },
  { expireAfterSeconds: 0 }
);

/* -------------------------------------------------------------------------- */
/* Utility helpers                                                            */
/* -------------------------------------------------------------------------- */

// Normalized check
seatLockSchema.methods.isActive = function () {
  return this.status === "HELD" && this.lockedUntil > new Date();
};

// Mark seat as used when booking is confirmed
seatLockSchema.methods.markUsed = function () {
  this.status = "USED";
  return this.save();
};

// Release a lock manually
seatLockSchema.methods.release = function () {
  this.status = "RELEASED";
  this.lockedUntil = new Date(); // expire immediately
  return this.save();
};

export default mongoose.model("SeatLock", seatLockSchema);
