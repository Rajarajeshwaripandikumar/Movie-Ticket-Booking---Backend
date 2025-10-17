// backend/src/routes/movies.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";
import Movie from "../models/Movie.js";

const router = Router();

/* --------------------------- BASE URL for Render --------------------------- */
const BASE_URL =
  process.env.BASE_URL ||
  "https://movie-ticket-booking-backend-o1m2.onrender.com";

/* ------------------------------ Paths & Multer ----------------------------- */
const uploadDir = path.resolve("uploads");
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
  const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
    file.mimetype
  );
  ok
    ? cb(null, true)
    : cb(new Error("Only image files (jpg, png, webp, gif) are allowed"));
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

/* ------------------------------ Helpers ----------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

function toRelativePoster(u) {
  // Normalize anything (absolute localhost, absolute prod, or relative) to a RELATIVE path
  if (!u) return "";
  try {
    if (/^https?:\/\//i.test(u)) {
      const a = new URL(u);
      return a.pathname; // keep just /uploads/...
    }
  } catch {
    /* not a URL */
  }
  return u.startsWith("/") ? u : `/${u}`;
}

function toPublicUrl(u) {
  // Ensure the client always receives an ABSOLUTE URL
  if (!u) return "";
  const rel = toRelativePoster(u);
  return `${BASE_URL}${rel}`;
}

function safeUnlink(anyUrlOrPath) {
  try {
    if (!anyUrlOrPath) return;
    const rel = toRelativePoster(anyUrlOrPath);
    const abs = path.join(process.cwd(), rel.replace(/^\/+/, "")); // /uploads/.. -> uploads/..
    // Only delete inside our uploads directory
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

/* ------------------------ Cast Normalization ------------------------------ */
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
    return Object.values(anyCast).map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof anyCast === "string") {
    const s = anyCast.trim();
    if (!s) return [];
    try {
      return castToStringArray(JSON.parse(s));
    } catch {
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  return [];
}

const castResponseObjects = (anyCast) =>
  castToStringArray(anyCast).map((name) => ({ actorName: name }));

/* ------------------------------ GET: list ---------------------------------- */
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
      // Always send absolute, frontend-safe URL
      posterUrl: toPublicUrl(m.posterUrl || m.image || m.poster || m.imageUrl || ""),
      cast: castResponseObjects(m.cast),
    }));

    res.json({ movies, count });
  } catch (err) {
    console.error("[Movies] GET / error:", err);
    res.status(500).json({ message: "Failed to load movies", error: err.message });
  }
});

/* ----------------------------- GET: search --------------------------------- */
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
        { cast: rx },
        { genre: rx },
      ];
    }

    if (genre) {
      const g = toArray(genre);
      if (g.length) filter.$or = [...(filter.$or || []), { genre: { $in: g } }];
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
      posterUrl: toPublicUrl(m.posterUrl || m.image || m.poster || m.imageUrl || ""),
      cast: castResponseObjects(m.cast),
    }));

    res.json({ movies, count: movies.length });
  } catch (err) {
    console.error("[Movies] GET /search error:", err);
    res.status(500).json({ message: "Failed to search movies", error: err.message });
  }
});

/* ---------------------------- GET: single by id ---------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid movie id" });

    const movie = await Movie.findById(id).lean();
    if (!movie) return res.status(404).json({ message: "Movie not found" });

    movie.posterUrl = toPublicUrl(movie.posterUrl || movie.image || movie.poster || movie.imageUrl || "");
    movie.cast = castResponseObjects(movie.cast);
    res.json(movie);
  } catch (err) {
    console.error("[Movies] GET /:id error:", err);
    res.status(500).json({ message: "Failed to fetch movie", error: err.message });
  }
});

/* ------------------------- POST: create (with poster) ---------------------- */
router.post("/", upload.single("poster"), async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.title || typeof payload.title !== "string") {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "Title is required" });
    }

    if (
      typeof payload.durationMins !== "undefined" &&
      Number.isNaN(Number(payload.durationMins))
    ) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "durationMins must be a number" });
    }

    payload.cast = castToStringArray(payload.cast);

    // ✅ Store RELATIVE path; never localhost
    if (req.file) {
      payload.posterUrl = `/uploads/${req.file.filename}`;
    } else if (payload.posterUrl || payload.image || payload.imageUrl || payload.poster) {
      // Normalize any absolute URL (including localhost) to relative
      const raw = payload.posterUrl || payload.image || payload.imageUrl || payload.poster;
      payload.posterUrl = toRelativePoster(raw);
    }

    if (typeof payload.genre === "string") payload.genre = payload.genre.trim();
    if (typeof payload.language === "string") payload.language = payload.language.trim();

    const movie = await Movie.create(payload);
    const out = movie.toObject();
    out.posterUrl = toPublicUrl(out.posterUrl);
    out.cast = castResponseObjects(out.cast);
    res.status(201).json(out);
  } catch (err) {
    console.error("[Movies] POST / error:", err);
    if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
    res.status(400).json({ message: "Failed to create movie", error: err.message });
  }
});

/* -------------------------- PUT: full update (legacy) ---------------------- */
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
      rating: typeof b.rating !== "undefined" ? Number(b.rating) : existing.rating,
      durationMins: typeof b.durationMins !== "undefined" ? Number(b.durationMins) : existing.durationMins,
      releaseDate: typeof b.releaseDate !== "undefined" ? b.releaseDate : existing.releaseDate,
      cast: typeof b.cast !== "undefined" ? castToStringArray(b.cast) : existing.cast,
      posterUrl: existing.posterUrl, // keep current by default
    };

    let oldPoster = null;
    if (req.file) {
      // ✅ new upload: store relative path
      payload.posterUrl = `/uploads/${req.file.filename}`;
      oldPoster = existing.posterUrl;
    } else if (b.posterUrl || b.image || b.imageUrl || b.poster) {
      // normalize any incoming value to relative
      payload.posterUrl = toRelativePoster(b.posterUrl || b.image || b.imageUrl || b.poster);
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();

    if (updated && oldPoster && toRelativePoster(oldPoster) !== toRelativePoster(updated.posterUrl)) {
      safeUnlink(oldPoster);
    }

    updated.posterUrl = toPublicUrl(updated.posterUrl);
    updated.cast = castResponseObjects(updated.cast);
    res.json(updated);
  } catch (err) {
    console.error("[Movies] PUT /:id error:", err);
    res.status(400).json({ message: "Failed to update movie", error: err.message });
  }
});

/* -------------------------- DELETE: movie (+ poster) ----------------------- */
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
