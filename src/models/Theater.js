// backend/src/models/Theater.js
import mongoose from "mongoose";

const TheaterSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Theater name is required"],
      trim: true,
      set: (v) => (v == null ? v : String(v).trim()),
    },
    city: {
      type: String,
      required: [true, "City is required"],
      trim: true,
      set: (v) => (v == null ? v : String(v).trim()),
    },
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
  // Ensure required fields exist (Mongoose required will also validate, but defensive here)
  this.name = this.name == null ? this.name : String(this.name).trim();
  this.city = this.city == null ? this.city : String(this.city).trim();

  this.nameLower = (this.name || "").trim().toLowerCase();
  this.cityLower = (this.city || "").trim().toLowerCase();

  // Ensure displayName/title fallback behavior is consistent
  if (!this.displayName && this.title) {
    this.displayName = String(this.title).trim();
  }

  next();
});

/* -------------------------------------------------------------------------- */
/*     Keep lowercase fields in sync for findOneAndUpdate / findByIdAndUpdate  */
/* -------------------------------------------------------------------------- */
// When using findOneAndUpdate/updateOne with { new: true } etc., pre('save') is not called.
// Mirror updates for common update patterns so lower fields remain consistent.
TheaterSchema.pre("findOneAndUpdate", function (next) {
  try {
    const update = this.getUpdate();
    if (!update) return next();

    // support $set and top-level updates
    const applied = update.$set ? update.$set : update;

    if (applied.name != null) {
      applied.name = String(applied.name).trim();
      (update.$set || update).nameLower = applied.name.toLowerCase();
    }
    if (applied.city != null) {
      applied.city = String(applied.city).trim();
      (update.$set || update).cityLower = applied.city.toLowerCase();
    }

    // keep displayName fallback if title is provided and displayName missing
    if ((applied.title != null) && !(applied.displayName)) {
      (update.$set || update).displayName = String(applied.title).trim();
    }

    this.setUpdate(update);
    next();
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/*                            Case-insensitive Index                          */
/* -------------------------------------------------------------------------- */
// compound unique over (nameLower, cityLower). Build in background to avoid blocking on large collections.
TheaterSchema.index(
  { nameLower: 1, cityLower: 1 },
  { unique: true, background: true }
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

// Hide internal lower-case fields and __v from JSON responses
TheaterSchema.set("toJSON", {
  virtuals: true,
  transform(doc, ret) {
    delete ret.__v;
    delete ret.nameLower;
    delete ret.cityLower;
    return ret;
  },
});
TheaterSchema.set("toObject", { virtuals: true });

export default mongoose.model("Theater", TheaterSchema);
