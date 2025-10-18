import mongoose from "mongoose";

const MovieSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    genre: { type: String, default: "" },
    releaseDate: { type: Date },
    durationMins: { type: Number, default: 0 },
    language: { type: String, default: "English" },
    cast: { type: [String], default: [] },
    director: { type: String, default: "" },
    rating: { type: Number, min: 0, max: 10, default: 0 },

    // ✅ Poster stored as backend-served or S3/Cloudinary URL
    posterUrl: { type: String, default: "" },

    // ✅ Uploader info for audit/admin tracking
    uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    uploaderRole: { type: String, default: "admin" },
  },
  { timestamps: true }
);

// ✅ Text search index
MovieSchema.index({
  title: "text",
  description: "text",
  cast: "text",
  director: "text",
});

// ✅ ESM-compatible default export (critical for Render)
const Movie = mongoose.model("Movie", MovieSchema);
export default Movie;
