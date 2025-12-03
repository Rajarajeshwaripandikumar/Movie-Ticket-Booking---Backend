// src/models/Booking.js
import mongoose from "mongoose";

const BookingSeatSchema = new mongoose.Schema({
  seatId: { type: String },   // e.g. "A1"
  row: { type: Number },
  col: { type: Number },
  price: { type: Number },
  meta: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const BookingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    showtime: { type: mongoose.Schema.Types.ObjectId, ref: "Showtime", required: true },

    seats: { type: [BookingSeatSchema], default: [] },

    totalAmount: { type: Number, required: true, default: 0 },

    razorpayOrderId: { type: String, index: true, sparse: true },
    razorpayPaymentId: { type: String, index: true, sparse: true },
    razorpaySignature: { type: String, sparse: true },

    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "CANCELLED", "FAILED", "REFUNDED"],
      default: "PENDING",
      index: true
    },

    note: String,
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// existing index
BookingSchema.index(
  { showtime: 1, "seats.seatId": 1, status: 1 },
  {
    partialFilterExpression: { status: { $in: ["CONFIRMED", "PENDING"] } },
    unique: false,
  }
);

// ✅ NEW: index for "my bookings" queries
BookingSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("Booking", BookingSchema);
