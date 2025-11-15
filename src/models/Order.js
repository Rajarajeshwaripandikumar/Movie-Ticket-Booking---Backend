// backend/src/models/Order.js
import mongoose from "mongoose";

const seatSchema = new mongoose.Schema(
  {
    // Either seatId (preferred) OR row+col for legacy/grid-style
    seatId: { type: String, default: null },
    row: { type: Number, default: null },
    col: { type: Number, default: null },

    // optional per-seat price snapshot (helpful for audit)
    price: { type: Number, default: 0 },
    // optional seat type snapshot (REGULAR, VIP, etc.)
    seatType: { type: String, default: "REGULAR" },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // canonical refs (match other models)
    movie: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true, index: true },
    showtime: { type: mongoose.Schema.Types.ObjectId, ref: "Showtime", required: true, index: true },

    // seats snapshot at time of order
    seats: { type: [seatSchema], default: [] },

    // amounts (store as integer rupees or smallest currency unit if you prefer)
    amount: { type: Number, required: true }, // total amount paid/charged
    currency: { type: String, default: "INR" },

    // Payment provider details (Razorpay etc.)
    paymentProvider: { type: String, default: "razorpay" },
    paymentProviderId: { type: String, default: null }, // provider-side payment id
    paymentCaptured: { type: Boolean, default: false },
    paymentMeta: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Link to internal payment intent if you maintain one
    paymentIntent: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentIntent", default: null },

    // useful for dedupe
    idempotencyKey: { type: String, index: true, sparse: true },

    // keep richer lifecycle statuses
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "CAPTURED", "REFUNDED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },

    // cancellation/refund metadata
    cancelledAt: { type: Date },
    refundedAt: { type: Date },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

/* -------------------- Indexes & utilities --------------------- */

// avoid accidental duplicate orders for same user/showtime + idempotencyKey
orderSchema.index({ user: 1, showtime: 1, idempotencyKey: 1 }, { unique: false, sparse: true });

// helper: return seat labels easily
orderSchema.methods.seatLabels = function () {
  return (this.seats || []).map((s) => (s.seatId ? s.seatId : (s.row !== null && s.col !== null ? `${s.row}-${s.col}` : "unknown")));
};

// small helper to mark captured
orderSchema.methods.markCaptured = async function (providerResult = {}) {
  this.status = this.status === "PENDING" ? "CAPTURED" : this.status;
  this.paymentCaptured = true;
  this.paymentMeta = { ...this.paymentMeta, captureResult: providerResult, capturedAt: new Date() };
  await this.save();
  return this;
};

// export
const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export default Order;
