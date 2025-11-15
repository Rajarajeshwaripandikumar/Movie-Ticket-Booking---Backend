// src/models/Booking.js
import mongoose from "mongoose";

const BookingSeatSchema = new mongoose.Schema({
  seatId: { type: String },   // e.g. "A1" (preferred) — keep for compatibility with different seat layouts
  row: { type: Number },
  col: { type: Number },
  price: { type: Number },    // price per seat (in rupees)
  meta: { type: mongoose.Schema.Types.Mixed } // optional seat metadata
}, { _id: false });

const BookingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    showtime: { type: mongoose.Schema.Types.ObjectId, ref: "Showtime", required: true },

    // seats chosen by user
    seats: { type: [BookingSeatSchema], default: [] },

    // currency amounts in rupees (NOT paise)
    totalAmount: { type: Number, required: true, default: 0 }, // sum of seat prices

    // Payment & gateway fields
    razorpayOrderId: { type: String, index: true, sparse: true },
    razorpayPaymentId: { type: String, index: true, sparse: true },
    razorpaySignature: { type: String, sparse: true },

    // booking lifecycle status
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "CANCELLED", "FAILED", "REFUNDED"],
      default: "PENDING",
      index: true
    },

    // optional notes / admin reason
    note: String,

    // meta for audit or provider IDs
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// index to prevent duplicate confirmed bookings for same showtime+seat
BookingSchema.index(
  { showtime: 1, "seats.seatId": 1, status: 1 },
  {
    partialFilterExpression: { status: { $in: ["CONFIRMED", "PENDING"] } },
    unique: false, // cannot make unique with array, keep as collection-level check in code
  }
);

export default mongoose.model("Booking", BookingSchema);
