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
        if (Array.isArray(val)) return val.map(String).map(s=>s.trim()).filter(Boolean);
        if (typeof val === "string") return val.split(",").map(s=>s.trim()).filter(Boolean);
        return [];
      },
    },
  },
  { timestamps: true }
);

// Case-insensitive unique name+city
TheaterSchema.index(
  { name: 1, city: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

// Optional virtual aliases if other code expects them
TheaterSchema.virtual("posterUrl").get(function () { return this.imageUrl; });
TheaterSchema.virtual("theaterImage").get(function () { return this.imageUrl; });
TheaterSchema.set("toJSON", { virtuals: true });
TheaterSchema.set("toObject", { virtuals: true });

export default mongoose.model("Theater", TheaterSchema);
