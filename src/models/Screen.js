import mongoose from "mongoose";

const ScreenSchema = new mongoose.Schema(
  {
    theater: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true },

    rows: { type: Number, required: true, min: 1 },
    cols: { type: Number, required: true, min: 1 },

    // ✅ Added for showtimes UI (your UI & toDto() already expect this)
    format: {
      type: String,
      trim: true,
      default: "", // "2D", "3D", "IMAX", "Dolby", etc.
    },
  },
  { timestamps: true }
);

// Unique screen name within a theater
ScreenSchema.index({ theater: 1, name: 1 }, { unique: true });

export default mongoose.models.Screen || mongoose.model("Screen", ScreenSchema);
