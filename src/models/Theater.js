// backend/src/models/Theater.js
import mongoose from "mongoose";

const TheaterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: "" },
    imageUrl: { type: String, default: "" },

    // optional synonyms (legacy clients sometimes use title/displayName)
    title: { type: String, trim: true, default: "" },
    displayName: { type: String, trim: true, default: "" },

    // numeric capacity fields used by analytics/occupancy
    capacity: {
      type: Number,
      default: null,
      set: (v) => {
        if (v == null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      },
    },
    totalSeats: {
      type: Number,
      default: null,
      set: (v) => {
        if (v == null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      },
    },

    amenities: {
      type: [String],
      default: [],
      set: (val) => {
        if (Array.isArray(val)) {
          return val.map(String).map((s) => s.trim()).filter(Boolean);
        }
        if (typeof val === "string") {
          return val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        return [];
      },
    },

    // Lowercase fields for reliable unique enforcement (case-insensitive across all MongoDBs)
    nameLower: { type: String, index: true },
    cityLower: { type: String, index: true },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/*                               Pre-save Hooks                               */
/* -------------------------------------------------------------------------- */
// Auto-populate lowercase fields for uniqueness enforcement
TheaterSchema.pre("save", function (next) {
  this.nameLower = (this.name || "").trim().toLowerCase();
  this.cityLower = (this.city || "").trim().toLowerCase();

  // Ensure displayName/title fallback behavior is consistent
  if (!this.displayName && this.title) {
    this.displayName = String(this.title).trim();
  }

  // If numeric strings were passed, setters already coerced them to Number or null.
  next();
});

/* -------------------------------------------------------------------------- */
/*                            Case-insensitive Index                          */
/* -------------------------------------------------------------------------- */
TheaterSchema.index(
  { nameLower: 1, cityLower: 1 },
  { unique: true } // enforce unique per lowercase pair
);

/* -------------------------------------------------------------------------- */
/*                                Virtual Fields                              */
/* -------------------------------------------------------------------------- */
TheaterSchema.virtual("posterUrl").get(function () {
  return this.imageUrl;
});
TheaterSchema.virtual("theaterImage").get(function () {
  return this.imageUrl;
});

// prefer explicit displayName, then title, then name
TheaterSchema.virtual("displayLabel").get(function () {
  return this.displayName || this.title || this.name || "";
});

// expose a legacy-friendly alias 'title' for templates that expect it
TheaterSchema.virtual("titleOrName").get(function () {
  return this.title || this.name || "";
});

TheaterSchema.set("toJSON", { virtuals: true });
TheaterSchema.set("toObject", { virtuals: true });

export default mongoose.model("Theater", TheaterSchema);
