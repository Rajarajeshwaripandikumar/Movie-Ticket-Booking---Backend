// backend/src/models/Pricing.js
import mongoose from "mongoose";

const pricingSchema = new mongoose.Schema(
  {
    theater: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", required: true, index: true },
    screen: { type: mongoose.Schema.Types.ObjectId, ref: "Screen", required: true, index: true },

    // seat type (consistent with Screen/Showtime seat types)
    seatType: { type: String, enum: ["REGULAR", "PREMIUM", "VIP"], required: true },

    // price in major currency units (e.g., INR rupees). If you prefer smallest unit (paise)
    // store as integer and document it in README.
    price: { type: Number, required: true },

    // currency code, default INR
    currency: { type: String, default: "INR" },

    // support dynamic pricing rules (optional JSON) e.g. peak multipliers, time-of-day rules
    dynamic: { type: Boolean, default: false },
    rules: { type: mongoose.Schema.Types.Mixed, default: {} },

    // last updated timestamp
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Unique constraint per theater+screen+seatType
pricingSchema.index({ theater: 1, screen: 1, seatType: 1 }, { unique: true });

// Convenience: return a normalized pricing object
pricingSchema.methods.toPayload = function () {
  return {
    id: this._id,
    theater: this.theater,
    screen: this.screen,
    seatType: this.seatType,
    price: this.price,
    currency: this.currency,
    dynamic: !!this.dynamic,
    rules: this.rules,
    updatedAt: this.updatedAt || this.updatedAt,
  };
};

/**
 * Static helper: resolve price for (theater, screen, seatType) with fallback:
 * 1) exact match (theater+screen+seatType)
 * 2) theater-level default for seatType (screen = null)
 * 3) global default for seatType (theater = null, screen = null)
 * Returns { price, currency, dynamic, rules } or null if not found.
 */
pricingSchema.statics.getPriceFor = async function ({ theaterId, screenId, seatType }) {
  const Pricing = this;

  // try exact match
  let p = await Pricing.findOne({ theater: theaterId, screen: screenId, seatType }).lean();
  if (p) return p;

  // theater-level fallback (screen null)
  p = await Pricing.findOne({ theater: theaterId, screen: null, seatType }).lean();
  if (p) return p;

  // global fallback
  p = await Pricing.findOne({ theater: null, screen: null, seatType }).lean();
  if (p) return p;

  return null;
};

/**
 * Upsert helper used by admin routes to set pricing
 * payload: { theater, screen, seatType, price, currency, dynamic, rules, updatedBy }
 */
pricingSchema.statics.upsertPricing = async function (payload) {
  const Pricing = this;
  const { theater, screen, seatType } = payload;
  const filter = { theater: theater || null, screen: screen || null, seatType };
  const update = {
    $set: {
      price: payload.price,
      currency: payload.currency || "INR",
      dynamic: !!payload.dynamic,
      rules: payload.rules || {},
      updatedAt: payload.updatedAt || new Date(),
      updatedBy: payload.updatedBy || null,
      meta: payload.meta || {},
    },
  };
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  return Pricing.findOneAndUpdate(filter, update, opts);
};

const Pricing = mongoose.models.Pricing || mongoose.model("Pricing", pricingSchema);
export default Pricing;
