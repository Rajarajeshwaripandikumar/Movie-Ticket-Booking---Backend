import mongoose from "mongoose";

const pricingSchema = new mongoose.Schema({
  theaterId: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", required: true },
  screenId: { type: mongoose.Schema.Types.ObjectId, ref: "Screen", required: true },
  seatType: { type: String, enum: ["Regular", "Premium", "VIP"], required: true },
  price: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model("Pricing", pricingSchema);
