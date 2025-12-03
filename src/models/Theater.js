// backend/src/models/Theater.js
import mongoose from "mongoose";

const TheaterSchema = new mongoose.Schema(
  {
    /* ----------------------------------------------------- */
    /* Basic theater info                                    */
    /* ----------------------------------------------------- */
    name: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true, index: true },
    address: { type: String, default: "", trim: true },

    /* ----------------------------------------------------- */
    /* Images                                                */
    /* ----------------------------------------------------- */
    logoUrl: { type: String, default: "" },
    bannerUrl: { type: String, default: "" },
    imageUrl: { type: String, default: "" }, // backward compatibility

    /* ----------------------------------------------------- */
    /* Owner & Admin                                         */
    /* ----------------------------------------------------- */
    // The super admin who created/approved this theater
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },

    // Theater admin assigned to manage this theater
    theaterAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },

    /* ----------------------------------------------------- */
    /* Status / Verification                                 */
    /* ----------------------------------------------------- */
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE", "PENDING_APPROVAL", "SUSPENDED"],
      default: "PENDING_APPROVAL",
      index: true,
    },

    isVerified: { type: Boolean, default: false },

    /* ----------------------------------------------------- */
    /* Contact                                               */
    /* ----------------------------------------------------- */
    contactEmail: { type: String, lowercase: true, trim: true },
    contactPhone: { type: String, trim: true },

    /* ----------------------------------------------------- */
    /* Amenities                                             */
    /* ----------------------------------------------------- */
    amenities: {
      type: [String],
      default: [],
      set: (val) => {
        if (Array.isArray(val)) return val.map(String).map((s) => s.trim()).filter(Boolean);
        if (typeof val === "string") return val.split(",").map((s) => s.trim()).filter(Boolean);
        return [];
      },
    },

    /* ----------------------------------------------------- */
    /* Geo fields for filtering                              */
    /* ----------------------------------------------------- */
    latitude: { type: Number },
    longitude: { type: Number },

    /* ----------------------------------------------------- */
    /* Meta & Custom fields                                  */
    /* ----------------------------------------------------- */
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

/* --------------------------------------------------------- */
/* Indexes                                                   */
/* --------------------------------------------------------- */

// Case-insensitive unique constraint for name + city
TheaterSchema.index(
  { name: 1, city: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

// Search index
TheaterSchema.index({
  name: "text",
  city: "text",
  address: "text",
});

/* --------------------------------------------------------- */
/* Virtuals                                                  */
/* --------------------------------------------------------- */

// For legacy code compatibility
TheaterSchema.virtual("posterUrl").get(function () {
  return this.imageUrl || this.logoUrl;
});

TheaterSchema.virtual("theaterImage").get(function () {
  return this.imageUrl || this.bannerUrl;
});

// Include virtuals in JSON
TheaterSchema.set("toJSON", { virtuals: true });
TheaterSchema.set("toObject", { virtuals: true });

export default mongoose.model("Theater", TheaterSchema);
