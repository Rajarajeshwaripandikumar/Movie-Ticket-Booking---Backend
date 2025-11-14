import mongoose from "mongoose";

/**
 * Screen Model
 * - Belongs to a Theater
 * - Has seat grid (rows × cols)
 * - Supports premium format tags (2D, 3D, IMAX, Dolby, 4DX, etc.)
 */

const ScreenSchema = new mongoose.Schema(
  {
    /* -----------------------------------------------------------
     🎭 Theater Reference
     ----------------------------------------------------------- */
    theater: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      required: true,
      index: true,
    },

    /* -----------------------------------------------------------
     🏷️ Screen Name
     ----------------------------------------------------------- */
    name: {
      type: String,
      required: true,
      trim: true,
    },

    /* -----------------------------------------------------------
     🎟️ Seat Grid (rows × columns)
     ----------------------------------------------------------- */
    rows: {
      type: Number,
      required: true,
      min: [1, "Rows must be at least 1"],
    },
    cols: {
      type: Number,
      required: true,
      min: [1, "Columns must be at least 1"],
    },

    /* -----------------------------------------------------------
     ⭐ Premium Format
     - Your UI already expects this field in toDto()
     - Auto-supported by Admin UI filters
     ----------------------------------------------------------- */
    format: {
      type: String,
      trim: true,
      default: "", // Allowed values: 2D, 3D, IMAX, Dolby, 4DX, etc.
    },
  },
  { timestamps: true }
);

/* -----------------------------------------------------------
🔒 Unique screen name per theater
E.g., "Screen 1" shouldn't exist twice under same theater
----------------------------------------------------------- */
ScreenSchema.index({ theater: 1, name: 1 }, { unique: true });

/* -----------------------------------------------------------
📦 Export
----------------------------------------------------------- */
export default mongoose.models.Screen || mongoose.model("Screen", ScreenSchema);
