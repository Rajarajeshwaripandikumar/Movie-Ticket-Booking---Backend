// backend/src/models/Movie.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Helpers to normalize cast/crew incoming shapes so the schema is forgiving:
 * - Accepts strings -> coerced to { name: "The String", character: "" }
 * - Accepts objects -> preserved (but trimmed)
 * - Accepts JSON-stringified arrays (from form posts) -> parsed and normalized
 */
function normalizeArrayField(value) {
  if (value == null) return [];

  // If it's a JSON string representing array/object, try parse
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      // if single object parsed, return as single-element array
      if (typeof parsed === "object" && parsed !== null) return [parsed];
    } catch {
      // not JSON -> treat as comma-separated or single value
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  // scalar -> single-element array
  return [String(value)];
}

function normalizeCastInput(inputArr) {
  const arr = normalizeArrayField(inputArr);
  return arr
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        const name = entry.trim();
        return name ? { name, character: "" } : null;
      }
      if (typeof entry === "object") {
        const name =
          entry.name ?? entry.actorName ?? (entry.actor && (entry.actor.name || entry.actor.fullName)) ?? "";
        const character = entry.character ?? entry.role ?? "";
        const cleanName = typeof name === "string" ? name.trim() : String(name);
        return cleanName ? { name: cleanName, character: String(character ?? "").trim() } : null;
      }
      // fallback
      const s = String(entry).trim();
      return s ? { name: s, character: "" } : null;
    })
    .filter(Boolean);
}

function normalizeCrewInput(inputArr) {
  const arr = normalizeArrayField(inputArr);
  return arr
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        const name = entry.trim();
        return name ? { name, role: "" } : null;
      }
      if (typeof entry === "object") {
        const name = entry.name ?? entry.fullName ?? (entry.person && (entry.person.name || entry.person.fullName)) ?? "";
        const role = entry.role ?? entry.job ?? "";
        const cleanName = typeof name === "string" ? name.trim() : String(name);
        return cleanName ? { name: cleanName, role: String(role ?? "").trim() } : null;
      }
      const s = String(entry).trim();
      return s ? { name: s, role: "" } : null;
    })
    .filter(Boolean);
}

const SubPerson = new Schema(
  {
    name: { type: String, trim: true, required: true },
    character: { type: String, trim: true, default: "" }, // used for cast
    role: { type: String, trim: true, default: "" }, // used for crew
  },
  { _id: false }
);

const MovieSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: "", maxlength: 5000 },

    // support both singular & plural naming used across front/back
    genres: {
      type: [String],
      default: [],
      set: function (v) {
        if (!v) return [];
        if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
        if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
        return [];
      },
      validate: [(v) => v.length <= 20, "Too many genres"],
    },
    genre: { type: String, default: "" }, // legacy single-field

    releasedAt: { type: Date },
    releaseDate: { type: Date }, // legacy alias

    runtimeMinutes: { type: Number, default: null },
    durationMins: { type: Number, default: null },

    languages: { type: [String], default: ["English"] },
    language: { type: String, default: "English" },

    // Cast & crew: store as subdocs { name, character } and { name, role }
    cast: {
      type: [SubPerson],
      default: [],
      set: function (v) {
        // incoming v may be array of strings / objects / JSON -> normalize to array of { name, character }
        try {
          return normalizeCastInput(v);
        } catch {
          return [];
        }
      },
      validate: [(v) => v.length <= 200, "Too many cast members"],
    },

    crew: {
      type: [SubPerson],
      default: [],
      set: function (v) {
        try {
          return normalizeCrewInput(v);
        } catch {
          return [];
        }
      },
      validate: [(v) => v.length <= 200, "Too many crew members"],
    },

    director: { type: String, default: "" },
    rating: { type: Number, min: 0, max: 10, default: 0 },

    // Poster and cloud metadata
    posterUrl: { type: String, default: "" },
    posterPublicId: { type: String, default: "" },

    // admin/audit fields
    uploaderId: { type: Schema.Types.ObjectId, ref: "User" },
    uploaderRole: { type: String, default: "admin" },

    inTheaters: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Weighted text index — title heavier than other fields for search scoring.
// If you modify this on production with a large collection, recreate index via Atlas or mongo shell.
MovieSchema.index(
  {
    title: "text",
    description: "text",
    "cast.name": "text",
    director: "text",
    "crew.name": "text",
  },
  { weights: { title: 8, "cast.name": 4, director: 3, description: 1 } }
);

// Virtual for absolute poster URL (helpful for frontends)
MovieSchema.virtual("posterAbsolute").get(function () {
  if (!this.posterUrl) return "";
  const src = String(this.posterUrl).replace(/\\/g, "/");
  if (/^https?:\/\//i.test(src)) return src;
  const base = process.env.APP_PUBLIC_BASE || process.env.BACKEND_PUBLIC_BASE || `http://localhost:${process.env.PORT || 8080}`;
  return `${base.replace(/\/$/, "")}${src.startsWith("/") ? "" : "/"}${src}`;
});

// Optional: a toObject/toJSON transform to keep output tidy and provide legacy aliases
MovieSchema.set("toObject", { virtuals: true });
MovieSchema.set("toJSON", {
  virtuals: true,
  transform(doc, ret) {
    // ensure older fields are available for legacy clients
    if (!ret.durationMins && ret.runtimeMinutes) ret.durationMins = ret.runtimeMinutes;
    if (!ret.releaseDate && ret.releasedAt) ret.releaseDate = ret.releasedAt;
    if (!ret.poster && ret.posterUrl) ret.poster = ret.posterUrl;
    // include posterAbsolute for convenience
    if (!ret.posterAbsolute && ret.posterUrl) {
      try {
        const src = String(ret.posterUrl).replace(/\\/g, "/");
        if (/^https?:\/\//i.test(src)) {
          ret.posterAbsolute = src;
        } else {
          const base = process.env.APP_PUBLIC_BASE || process.env.BACKEND_PUBLIC_BASE || `http://localhost:${process.env.PORT || 8080}`;
          ret.posterAbsolute = `${base.replace(/\/$/, "")}${src.startsWith("/") ? "" : "/"}${src}`;
        }
      } catch {
        ret.posterAbsolute = ret.posterUrl;
      }
    }
    return ret;
  },
});

// Prevent OverwriteModelError in watch/dev environments
const Movie = mongoose.models.Movie || mongoose.model("Movie", MovieSchema);
export default Movie;
