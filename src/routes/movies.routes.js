// backend/src/routes/movies.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import Movie from "../models/Movie.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                                CONFIG SETUP                                */
/* -------------------------------------------------------------------------- */
const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  "https://movie-ticket-booking-backend-o1m2.onrender.com";

// local temp/upload dir used by multer (we still keep a temp dir)
const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";
const uploadDir = path.resolve(UPLOADS_DIR);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const MIME_EXT = {
  "image/jpeg": ".jpeg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/* -------------------------------------------------------------------------- */
/*                         Cloudinary configuration                            */
/* -------------------------------------------------------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* -------------------------------------------------------------------------- */
/*                                MULTER SETUP                                */
/* -------------------------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
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
  ok
    ? cb(null, true)
    : cb(
        new multer.MulterError(
          "LIMIT_UNEXPECTED_FILE",
          "Only image files are allowed"
        )
      );
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

function logUpload(req, _res, next) {
  if (req.file) {
    console.log(
      "[uploads] saved:",
      req.file.filename,
      "->",
      path.join(uploadDir, req.file.filename)
    );
  } else {
    console.log("[uploads] no file on this request");
  }
  next();
}

/* -------------------------------------------------------------------------- */
/*                                DEBUG LOGGER                                */
/* -------------------------------------------------------------------------- */
router.use((req, res, next) => {
  console.log("[Movies API]", req.method, req.originalUrl);
  console.log("   Authorization:", req.headers.authorization ? "✅ present" : "❌ missing");
  next();
});

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

const toRelativePoster = (u) => {
  if (!u) return "";
  try {
    if (/^https?:\/\//i.test(u)) {
      const a = new URL(u);
      return a.pathname;
    }
  } catch {}
  return u.startsWith("/") ? u : `/${u}`;
};

const onlyUploads = (relish) => {
  const p = toRelativePoster(relish);
  return p.startsWith("/uploads/") ? p : "";
};

const toPublicUrl = (u) => {
  if (!u) return "";
  // if it's already an absolute URL, return as-is (Cloudinary URLs are absolute)
  if (/^https?:\/\//i.test(String(u))) return String(u);
  const rel = toRelativePoster(u);
  return `${BASE_URL}${rel}`;
};

const safeUnlink = (anyUrlOrPath) => {
  try {
    if (!anyUrlOrPath) return;
    const rel = toRelativePoster(anyUrlOrPath);
    const abs = path.join(process.cwd(), rel.replace(/^\/+/, ""));
    if (abs.startsWith(uploadDir) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) {
    console.warn("[safeUnlink] error:", e?.message || e);
  }
};

const toArray = (v) =>
  Array.isArray(v)
    ? v
    : typeof v === "string"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

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
    return Object.values(anyCast)
      .map((v) => String(v).trim())
      .filter(Boolean);
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

/* ---------------- Cloudinary helpers ---------------- */
function extractPublicIdFromUrlOrId(urlOrId) {
  if (!urlOrId) return null;
  try {
    const s = String(urlOrId).trim();
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const p = u.pathname;
      const idx = p.indexOf("/upload/");
      if (idx >= 0) {
        let after = p.slice(idx + "/upload/".length);
        after = after.replace(/^v\d+\//, "");
        after = after.replace(/\.[a-z0-9]+$/i, "");
        return after;
      }
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

async function deleteCloudinaryImageMaybe(ref) {
  if (!ref) return;
  // ref could be a Cloudinary public_id or a full URL, or a local /uploads/ path
  const publicId = extractPublicIdFromUrlOrId(ref);
  if (publicId) {
    try {
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      console.log("[Cloudinary] destroy result:", publicId, result);
    } catch (e) {
      console.warn("[Cloudinary] failed to destroy", publicId, e?.message || e);
    }
    return;
  }
  // if not cloudinary, maybe local file
  safeUnlink(ref);
}

/* -------------------------------------------------------------------------- */
/*                                ROUTES                                      */
/* -------------------------------------------------------------------------- */

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
      posterUrl: toPublicUrl(m.posterUrl || ""),
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

    const docs = await Movie.find(filter).sort({ releaseDate: -1, createdAt: -1 }).limit(Math.min(200, Number(limit))).lean();

    const movies = docs.map((m) => ({
      ...m,
      posterUrl: toPublicUrl(m.posterUrl || ""),
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

    movie.posterUrl = toPublicUrl(movie.posterUrl || "");
    movie.cast = castResponseObjects(movie.cast);
    res.json(movie);
  } catch (err) {
    console.error("[Movies] GET /:id error:", err);
    res.status(500).json({ message: "Failed to fetch movie", error: err.message });
  }
});

/* ------------------------- POST: create (admin only) ---------------------- */
router.post("/", requireAuth, requireAdmin, upload.single("image"), logUpload, async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.title || typeof payload.title !== "string") {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "Title is required" });
    }

    // normalize cast
    payload.cast = castToStringArray(payload.cast);

    // If a file was uploaded -> push to Cloudinary, then delete local temp
    if (req.file) {
      const localPath = path.join(uploadDir, req.file.filename);
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await cloudinary.uploader.upload(localPath, {
          folder,
          use_filename: true,
          unique_filename: true,
          resource_type: "image",
        });
        // delete local temp file
        safeUnlink(localPath);
        payload.posterUrl = result.secure_url;
        // store public id for easier deletion later (optional field)
        payload.posterPublicId = result.public_id;
      } catch (e) {
        safeUnlink(localPath);
        console.error("[Movies] cloudinary upload failed:", e);
        return res.status(500).json({ message: "Failed to upload poster", error: e?.message || e });
      }
    }

    // basic validation: durationMins numeric
    if (payload.durationMins !== undefined && payload.durationMins !== "") {
      const n = Number(payload.durationMins);
      if (Number.isNaN(n)) {
        if (req.file && payload.posterPublicId) {
          // remove uploaded cloud image if we created one
          await deleteCloudinaryImageMaybe(payload.posterPublicId);
        }
        return res.status(400).json({ message: "durationMins must be a number" });
      }
      payload.durationMins = n;
    }

    // record uploader info
    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const movie = await Movie.create(payload);
    const out = movie.toObject();
    out.posterUrl = toPublicUrl(out.posterUrl);
    out.cast = castResponseObjects(out.cast);
    res.status(201).json({ ok: true, data: out });
  } catch (err) {
    console.error("[Movies] POST / error:", err);
    if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
    res.status(400).json({ message: "Failed to create movie", error: err.message });
  }
});

/* -------------------------- PUT: update (admin only) ---------------------- */
router.put("/:id", requireAuth, requireAdmin, upload.single("image"), logUpload, async (req, res) => {
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
      title: b.title ?? existing.title,
      description: b.description ?? existing.description,
      genre: b.genre ?? existing.genre,
      language: b.language ?? existing.language,
      director: b.director ?? existing.director,
      rating: b.rating ?? existing.rating,
      durationMins: b.durationMins ?? existing.durationMins,
      releaseDate: b.releaseDate ?? existing.releaseDate,
      cast: b.cast ? castToStringArray(b.cast) : existing.cast,
      posterUrl: existing.posterUrl,
      // preserve posterPublicId if present
      posterPublicId: existing.posterPublicId,
    };

    let oldPosterRef = null;
    if (req.file) {
      // upload new poster to Cloudinary
      const localPath = path.join(uploadDir, req.file.filename);
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await cloudinary.uploader.upload(localPath, {
          folder,
          use_filename: true,
          unique_filename: true,
          resource_type: "image",
        });
        safeUnlink(localPath);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
        oldPosterRef = existing.posterPublicId || existing.posterUrl;
      } catch (e) {
        safeUnlink(localPath);
        console.error("[Movies] cloudinary upload failed (update):", e);
        return res.status(500).json({ message: "Failed to upload poster", error: e?.message || e });
      }
    }

    // record uploader info
    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();

    // If we replaced the poster, delete the old one (Cloudinary or local)
    if (updated && oldPosterRef && oldPosterRef !== payload.posterUrl && oldPosterRef !== payload.posterPublicId) {
      // delete old poster if it was a cloudinary id or url, or delete local file
      try {
        await deleteCloudinaryImageMaybe(oldPosterRef);
      } catch (e) {
        console.warn("[Movies] failed to delete previous poster:", e?.message || e);
      }
    }

    updated.posterUrl = toPublicUrl(updated.posterUrl);
    updated.cast = castResponseObjects(updated.cast);
    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies] PUT /:id error:", err);
    res.status(400).json({ message: "Failed to update movie", error: err.message });
  }
});

/* -------------------------- DELETE: movie (admin only) -------------------- */
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid movie id" });

    const removed = await Movie.findByIdAndDelete(id).lean();
    if (!removed) return res.status(404).json({ message: "Movie not found" });

    // remove poster (cloudinary public id or url OR local uploads path)
    if (removed.posterPublicId) {
      await deleteCloudinaryImageMaybe(removed.posterPublicId);
    } else if (removed.posterUrl) {
      // if posterUrl is cloudinary url, delete by extracting public id; otherwise unlink local
      await deleteCloudinaryImageMaybe(removed.posterUrl);
      // also attempt to unlink local path if it was stored as /uploads/...
      safeUnlink(removed.posterUrl);
    }

    res.json({ ok: true, message: "Movie deleted", id: removed._id });
  } catch (err) {
    console.error("[Movies] DELETE /:id error:", err);
    res.status(500).json({ message: "Failed to delete movie", error: err.message });
  }
});

/* ----------------------- Multer-specific error handler -------------------- */
router.use((err, _req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ message: "File too large (max 3MB)" });
    }
    return res.status(400).json({ message: err.message || "File upload error" });
  }
  return next(err);
});

export default router;
