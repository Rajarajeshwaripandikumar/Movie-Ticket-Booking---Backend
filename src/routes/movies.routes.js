// src/routes/movies.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";
import Movie from "../models/Movie.js";

const router = Router();

/* -------------------------- Uploads (multer) --------------------------- */
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const fileFilter = (_, file, cb) => {
  const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype);
  ok ? cb(null, true) : cb(new Error("Only image files (jpg, png, webp, gif) are allowed"));
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

/* ------------------------------ Helpers -------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

function safeUnlink(relativeUrl) {
  try {
    if (!relativeUrl) return;
    // relativeUrl like "/uploads/xxx.jpg" or "uploads/xxx.jpg"
    const normalized = relativeUrl.startsWith("/") ? relativeUrl.slice(1) : relativeUrl;
    const abs = path.join(process.cwd(), normalized);
    if (abs.startsWith(uploadDir) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}

const toArray = (v) =>
  Array.isArray(v)
    ? v
    : typeof v === "string"
    ? v.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

/* ------------------------ Cast Normalization --------------------------- */
/** Store as [String] in DB (matches your schema) */
function castToStringArray(anyCast) {
  if (!anyCast) return [];

  if (Array.isArray(anyCast)) {
    return anyCast
      .map((c) => {
        if (typeof c === "string") return c.trim();
        if (c && typeof c === "object") {
          return (c.actorName || c.name || c.character || "").toString().trim();
        }
        return String(c).trim();
      })
      .filter(Boolean);
  }

  if (typeof anyCast === "object") {
    const vals = Object.values(anyCast).filter(Boolean);
    const perChar = vals.length > 10 && vals.every((v) => typeof v === "string" && v.length === 1);
    if (perChar) {
      const joined = vals.join("");
      try {
        const parsed = JSON.parse(joined);
        return castToStringArray(parsed);
      } catch {
        return joined.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
    return vals.map((v) => String(v).trim()).filter(Boolean);
  }

  if (typeof anyCast === "string") {
    const s = anyCast.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      return castToStringArray(parsed);
    } catch {
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }

  return [];
}

/** Pretty objects for UI response */
function castResponseObjects(anyCast) {
  return castToStringArray(anyCast).map((name) => ({ actorName: name }));
}

/* ------------------------------ GET: list ------------------------------- */
/**
 * GET /api/movies?limit=20&skip=0
 * Returns { movies: [...], count }
 */
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const skip = Number(req.query.skip) || 0;

    const [docs, count] = await Promise.all([
      Movie.find()
        .sort({ releaseDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Movie.countDocuments(),
    ]);

    const movies = docs.map((m) => ({
      ...m,
      cast: castResponseObjects(m.cast),
    }));

    res.json({ movies, count });
  } catch (err) {
    console.error("[Movies] GET / error:", err);
    res.status(500).json({ message: "Failed to load movies", error: err.message });
  }
});

/* ----------------------------- GET: search ------------------------------ */
/**
 * GET /api/movies/search?q=...&genre=...&date=...
 * - q matches title/description/cast/director (case-insensitive)
 */
router.get("/search", async (req, res) => {
  try {
    const { q, genre, date, limit = 50 } = req.query;
    const filter = {};

    if (q) {
      const rx = new RegExp(q, "i");
      filter.$or = [
        { title: rx },
        { description: rx },
        { director: rx },
        // cast is [String] in your schema
        { cast: rx },
        // if you sometimes store comma string in genre
        { genre: rx },
      ];
    }

    if (genre) {
      // allow comma-separated genres in your single-string schema
      const g = toArray(genre);
      if (g.length) {
        filter.$or = [
          ...(filter.$or || []),
          { genre: { $in: g } },
        ];
      }
    }

    if (date) {
      const d = new Date(date);
      if (!isNaN(d)) filter.releaseDate = { $lte: d };
    }

    const docs = await Movie.find(filter)
      .sort({ releaseDate: -1, createdAt: -1 })
      .limit(Math.min(200, Number(limit)))
      .lean();

    const movies = docs.map((m) => ({
      ...m,
      cast: castResponseObjects(m.cast),
    }));

    res.json({ movies, count: movies.length });
  } catch (err) {
    console.error("[Movies] GET /search error:", err);
    res.status(500).json({ message: "Failed to search movies", error: err.message });
  }
});

/* ---------------------------- GET: single by id ------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid movie id" });

    const movie = await Movie.findById(id).lean();
    if (!movie) return res.status(404).json({ message: "Movie not found" });

    movie.cast = castResponseObjects(movie.cast);
    res.json(movie);
  } catch (err) {
    console.error("[Movies] GET /:id error:", err);
    res.status(500).json({ message: "Failed to fetch movie", error: err.message });
  }
});

/* ------------------------- POST: create (with poster) ------------------- */
/**
 * POST /api/movies
 * Field name for file: "poster"
 * Body (form-data or json): title (required), description, genre, language, durationMins, releaseDate, director, rating, cast
 */
router.post("/", upload.single("poster"), async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.title || typeof payload.title !== "string" || payload.title.trim().length === 0) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "Title is required" });
    }

    // Validate duration
    if (typeof payload.durationMins !== "undefined" && Number.isNaN(Number(payload.durationMins))) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "durationMins must be a number" });
    }

    // Sanitize cast to [String]
    payload.cast = castToStringArray(payload.cast);

    // Poster
    if (req.file) {
      payload.posterUrl = `/uploads/${req.file.filename}`;
    }

    // Trim some strings
    if (typeof payload.genre === "string") payload.genre = payload.genre.trim();
    if (typeof payload.language === "string") payload.language = payload.language.trim();

    const movie = await Movie.create(payload);
    const out = movie.toObject();
    out.cast = castResponseObjects(out.cast);
    res.status(201).json(out);
  } catch (err) {
    console.error("[Movies] POST / error:", err);
    if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
    res.status(400).json({ message: "Failed to create movie", error: err.message });
  }
});

/* -------------------------- PATCH: update (safe set) -------------------- */
/**
 * PATCH /api/movies/:id
 * Only updates provided fields; accepts same inputs as POST.
 */
router.patch("/:id", upload.single("poster"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "Invalid movie id" });
    }

    const b = req.body || {};
    const $set = {};

    // Strings
    if (typeof b.title !== "undefined") $set.title = String(b.title).trim();
    if (typeof b.description !== "undefined") $set.description = b.description;
    if (typeof b.genre !== "undefined") $set.genre = String(b.genre).trim();
    if (typeof b.language !== "undefined") $set.language = String(b.language).trim();
    if (typeof b.director !== "undefined") $set.director = b.director;
    if (typeof b.rating !== "undefined") $set.rating = Number(b.rating);

    // Dates / numbers
    if (typeof b.releaseDate !== "undefined") $set.releaseDate = b.releaseDate;
    if (typeof b.durationMins !== "undefined") {
      if (Number.isNaN(Number(b.durationMins))) {
        if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
        return res.status(400).json({ message: "durationMins must be a number" });
      }
      $set.durationMins = Number(b.durationMins);
    }

    // Cast
    if (typeof b.cast !== "undefined") {
      $set.cast = castToStringArray(b.cast);
    }

    // Poster
    if (req.file) $set.posterUrl = `/uploads/${req.file.filename}`;

    const existing = await Movie.findById(id).lean();
    if (!existing) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(404).json({ message: "Movie not found" });
    }

    const updated = await Movie.findByIdAndUpdate(id, { $set }, { new: true, runValidators: true }).lean();

    // if poster replaced, remove old file
    if (req.file && existing.posterUrl && existing.posterUrl !== updated.posterUrl) {
      safeUnlink(existing.posterUrl);
    }

    updated.cast = castResponseObjects(updated.cast);
    res.json(updated);
  } catch (err) {
    console.error("[Movies] PATCH /:id error:", err);
    res.status(400).json({ message: "Failed to update movie", error: err.message });
  }
});

/* -------------------------- PUT: full update (legacy) ------------------- */
router.put("/:id", upload.single("poster"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "Invalid movie id" });
    }

    const existing = await Movie.findById(id).lean();
    if (!existing) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(404).json({ message: "Movie not found" });
    }

    const b = req.body || {};
    const payload = {
      title: typeof b.title !== "undefined" ? String(b.title).trim() : existing.title,
      description: typeof b.description !== "undefined" ? b.description : existing.description,
      genre: typeof b.genre !== "undefined" ? String(b.genre).trim() : existing.genre,
      language: typeof b.language !== "undefined" ? String(b.language).trim() : existing.language,
      director: typeof b.director !== "undefined" ? b.director : existing.director,
      rating:
        typeof b.rating !== "undefined" ? Number(b.rating) : existing.rating,
      durationMins:
        typeof b.durationMins !== "undefined"
          ? Number(b.durationMins)
          : existing.durationMins,
      releaseDate:
        typeof b.releaseDate !== "undefined" ? b.releaseDate : existing.releaseDate,
      cast:
        typeof b.cast !== "undefined" ? castToStringArray(b.cast) : existing.cast,
      posterUrl: existing.posterUrl,
    };

    let oldPoster = null;
    if (req.file) {
      payload.posterUrl = `/uploads/${req.file.filename}`;
      if (existing.posterUrl) oldPoster = existing.posterUrl;
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    if (updated && oldPoster) safeUnlink(oldPoster);

    updated.cast = castResponseObjects(updated.cast);
    res.json(updated);
  } catch (err) {
    console.error("[Movies] PUT /:id error:", err);
    res.status(400).json({ message: "Failed to update movie", error: err.message });
  }
});

/* -------------------------- DELETE: movie (+ poster) -------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid movie id" });

    const removed = await Movie.findByIdAndDelete(id).lean();
    if (!removed) return res.status(404).json({ message: "Movie not found" });

    if (removed.posterUrl) safeUnlink(removed.posterUrl);

    res.json({ message: "Movie deleted", id: removed._id });
  } catch (err) {
    console.error("[Movies] DELETE /:id error:", err);
    res.status(500).json({ message: "Failed to delete movie", error: err.message });
  }
});

export default router;
