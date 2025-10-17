// backend/src/models/Theater.js
import mongoose from "mongoose";

const TheaterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: "" },
    imageUrl: { type: String, default: "" },

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

TheaterSchema.set("toJSON", { virtuals: true });
TheaterSchema.set("toObject", { virtuals: true });

export default mongoose.model("Theater", TheaterSchema);
