// backend/src/models/Movie.js
import mongoose from "mongoose";

const MovieSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // who added the movie
    theaterOwner: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", default: null }, // optional: which theater owns this movie (if created by theater admin)
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    genres: { type: [String], default: [] },
    releaseDate: { type: Date },
    durationMins: { type: Number, default: 0 },
    languages: { type: [String], default: ["English"] },
    cast: { type: [String], default: [] },
    director: { type: String, default: "" },
    rating: { type: Number, min: 0, max: 10, default: 0 },
    posterUrl: { type: String, default: "" },
    trailerUrl: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

MovieSchema.index({
  title: "text",
  description: "text",
  cast: "text",
  director: "text",
  genres: "text",
});

export default mongoose.model("Movie", MovieSchema);
