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

const MIME_EXT = {
  "image/jpeg": ".jpeg",
  "image/jpg": ".jpg", // some clients send this
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    // ensure we always save with a real extension
    let ext = (path.extname(file.originalname || "") || "").toLowerCase();
    if (!ext) ext = MIME_EXT[file.mimetype] || ".jpg";

    const base = (path.parse(file.originalname || "").name || "poster")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");

    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

const fileFilter = (_, file, cb) => {
  const ok = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ].includes(file.mimetype);
  ok ? cb(null, true) : cb(new Error("Only image files are allowed"));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

/* ------------------------------ Helpers ----------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

function toRelativePoster(u) {
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

// Only allow /uploads/* to be stored; everything else is dropped
function onlyUploads(relish) {
  const p = toRelativePoster(relish);
  return p.startsWith("/uploads/") ? p : "";
}

function toPublicUrl(u) {
  if (!u) return "";
  const rel = toRelativePoster(u);
  return `${BASE_URL}${rel}`;
}

function safeUnlink(anyUrlOrPath) {
  try {
    if (!anyUrlOrPath) return;
    const rel = toRelativePoster(anyUrlOrPath); // /uploads/...
    const abs = path.join(process.cwd(), rel.replace(/^\/+/, "")); // -> uploads/...
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
      Movie.find().sort({ releaseDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Movie.countDocuments(),
    ]);

    const movies = docs.map((m) => ({
      ...m,
      posterUrl: toPublicUrl(
        onlyUploads(m.posterUrl || m.image || m.poster || m.imageUrl || "")
      ),
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
      filter.$or = [{ title: rx }, { description: rx }, { director: rx }, { cast: rx }, { genre: rx }];
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
      posterUrl: toPublicUrl(
        onlyUploads(m.posterUrl || m.image || m.poster || m.imageUrl || "")
      ),
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

    movie.posterUrl = toPublicUrl(
      onlyUploads(movie.posterUrl || movie.image || movie.poster || movie.imageUrl || "")
    );
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

    // Store RELATIVE path only
    if (req.file) {
      payload.posterUrl = `/uploads/${req.file.filename}`;
    } else if (payload.posterUrl || payload.image || payload.imageUrl || payload.poster) {
      payload.posterUrl = onlyUploads(
        payload.posterUrl || payload.image || payload.imageUrl || payload.poster
      );
    }

    if (typeof payload.genre === "string") payload.genre = payload.genre.trim();
    if (typeof payload.language === "string") payload.language = payload.language.trim();

    const movie = await Movie.create(payload);
    const out = movie.toObject();
    out.posterUrl = toPublicUrl(onlyUploads(out.posterUrl));
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
      posterUrl: existing.posterUrl, // default: keep
    };

    let oldPoster = null;
    if (req.file) {
      payload.posterUrl = `/uploads/${req.file.filename}`;
      oldPoster = existing.posterUrl;
    } else if (b.posterUrl || b.image || b.imageUrl || b.poster) {
      payload.posterUrl = onlyUploads(b.posterUrl || b.image || b.imageUrl || b.poster);
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();

    if (updated && oldPoster && onlyUploads(oldPoster) !== onlyUploads(updated.posterUrl)) {
      safeUnlink(oldPoster);
    }

    updated.posterUrl = toPublicUrl(onlyUploads(updated.posterUrl));
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
