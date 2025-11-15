// backend/src/models/Movie.js
import mongoose from "mongoose";

const personSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // For cast: character; for crew: role/job
    character: { type: String, default: "" },
    role: { type: String, default: "" },
  },
  { _id: false }
);

const MovieSchema = new mongoose.Schema(
  {
    // Basic
    title: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: "" },
    synopsis: { type: String, default: "" },

    // metadata
    genres: { type: [String], default: [], set: (v) => (Array.isArray(v) ? v.map(String) : String(v || "").split(",").map(s=>s.trim())) },
    languages: { type: [String], default: ["English"] },

    director: { type: String, default: "" },
    cast: { type: [personSchema], default: [] },
    crew: { type: [personSchema], default: [] },

    // runtime / dates
    runtimeMinutes: { type: Number, default: 0 },
    releasedAt: { type: Date, default: null },
    inTheaters: { type: Boolean, default: false },

    // poster
    posterUrl: { type: String, default: "" },
    posterPublicId: { type: String, default: "" },

    // ratings / external ids
    rating: { type: Number, min: 0, max: 10, default: 0 },
    externalIds: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Status
    status: { type: String, enum: ["DRAFT", "PUBLISHED", "ARCHIVED"], default: "PUBLISHED", index: true },

    /* ---------------- Ownership / uploader metadata ---------------- */
    // which theater "owns" or promotes this movie (optional)
    theater: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", default: null, index: true },

    // who uploaded/edited this movie and their role at the time
    uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploaderRole: { type: String, default: null },

    // misc
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

/* ---------------------- Indexes & full text search ---------------------- */
// text index for search across common fields
MovieSchema.index(
  {
    title: "text",
    description: "text",
    synopsis: "text",
    "cast.name": "text",
    director: "text",
    "crew.name": "text",
  },
  { weights: { title: 5, description: 2, synopsis: 2, "cast.name": 3 } }
);

// helpful compound index for theater filters
MovieSchema.index({ theater: 1, status: 1, releasedAt: -1 });

/* ------------------------ Virtuals & methods ---------------------------- */
MovieSchema.virtual("poster").get(function () {
  return this.posterUrl || "";
});

MovieSchema.methods.toPayload = function () {
  return {
    id: this._id,
    title: this.title,
    description: this.description,
    synopsis: this.synopsis,
    genres: this.genres,
    languages: this.languages,
    director: this.director,
    cast: this.cast,
    crew: this.crew,
    runtimeMinutes: this.runtimeMinutes,
    releasedAt: this.releasedAt,
    inTheaters: this.inTheaters,
    posterUrl: this.posterUrl,
    status: this.status,
    theater: this.theater,
    uploaderId: this.uploaderId,
    uploaderRole: this.uploaderRole,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/* --------------------- Export model (idempotent) ------------------------ */
const Movie = mongoose.models.Movie || mongoose.model("Movie", MovieSchema);
export default Movie;
