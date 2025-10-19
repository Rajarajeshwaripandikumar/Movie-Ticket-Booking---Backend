import mongoose from "mongoose";

const pricingSchema = new mongoose.Schema({
  theaterId: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", required: true },
  screenId: { type: mongoose.Schema.Types.ObjectId, ref: "Screen", required: true },
  seatType: { type: String, enum: ["Regular", "Premium", "VIP"], required: true },
  price: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  updatedAt: { type: Date, default: Date.now }
});

pricingSchema.index({ theaterId: 1, screenId: 1, seatType: 1 }, { unique: true });

export default mongoose.model("Pricing", pricingSchema);
