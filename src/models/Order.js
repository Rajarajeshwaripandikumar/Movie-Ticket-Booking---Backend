// backend/src/models/Order.js
import mongoose from "mongoose";

const seatSchema = new mongoose.Schema({
  row: { type: Number },
  col: { type: Number },
}, { _id: false });

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    movieId: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true },
    showtimeId: { type: mongoose.Schema.Types.ObjectId, ref: "Showtime", required: true },
    seats: [seatSchema],
    amount: { type: Number, required: true }, // store as number (not string)
    paymentId: { type: String }, // optional gateway id
    status: { type: String, enum: ["PENDING", "CONFIRMED", "CANCELLED"], default: "CONFIRMED" },
  },
  { timestamps: true }
);

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export default Order;
