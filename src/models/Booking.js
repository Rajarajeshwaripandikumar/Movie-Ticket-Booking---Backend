// src/models/Booking.js
import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  showtime: { type: mongoose.Schema.Types.ObjectId, ref: "Showtime", required: true },
  seats: [{ row: Number, col: Number }],
  amount: Number,
  status: { type: String, enum: ["CONFIRMED", "CANCELLED"], default: "CONFIRMED" },
}, { timestamps: true });

export default mongoose.model("Booking", bookingSchema);
