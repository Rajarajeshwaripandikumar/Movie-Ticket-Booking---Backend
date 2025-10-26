// backend/src/routes/movies.routes.js
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import Movie from "../models/Movie.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

dotenv.config();
const router = express.Router();

/* --------------------------- Cloudinary config --------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* ------------------------------ Multer ---------------------------------- */
const memoryStorage = multer.memoryStorage();
const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const fileFilter = (_, file, cb) => {
  const ok = allowedMimes.includes(file.mimetype);
  ok ? cb(null, true) : cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only image files are allowed"));
};

const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

/* ----------------------------- Helpers ---------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

function uploadBufferToCloudinary(buffer, folder = "movies") {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", use_filename: true, unique_filename: true },
      (err, result) => {
        if (err) {
          console.error("[Cloudinary] upload error:", err?.message || err);
          return reject(err);
        }
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

/**
 * Normalize incoming value into an array of trimmed strings.
 * Accepts: Array, JSON-array-string, comma-separated string, or undefined/null.
 */
function normalizeToArray(value) {
  if (!value && value !== "") return [];
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);

  // try JSON parse
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch (e) {
      // not JSON — fallthrough to comma split
    }

    // comma-separated fallback
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // fallback: convert to single string
  return [String(value).trim()].filter(Boolean);
}

/* ----------------------------- Public API -------------------------------- */

/**
 * GET /api/movies
 * public — paginated, optional search
 */
router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const { q, genre, page = 1, limit = 20, onlyInTheaters } = req.query;
    const filter = {};

    if (q) {
      const rx = new RegExp(String(q), "i");
      // search title, director, cast, crew, genres, languages
      filter.$or = [
        { title: rx },
        { director: rx },
        { cast: rx },
        { crew: rx },
        { genres: rx },
        { languages: rx },
      ];
    }
    if (genre) filter.genres = genre;
    if (onlyInTheaters === "true" || onlyInTheaters === true) filter.inTheaters = true;

    const safeLimit = Math.min(Number(limit) || 20, 1000);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [movies, total] = await Promise.all([
      Movie.find(filter).sort({ releasedAt: -1, updatedAt: -1 }).skip(skip).limit(safeLimit).lean(),
      Movie.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      movies,
      count: total,
      page: safePage,
      limit: safeLimit,
      hasMore: skip + movies.length < total,
    });
  } catch (err) {
    console.error("[Movies] GET / error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch movies", error: err.message });
  }
});

/**
 * GET /api/movies/:id
 * param restricted to 24-hex ObjectId to avoid matching '/admin'
 */
router.get("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const movie = await Movie.findById(id).lean();
    if (!movie) return res.status(404).json({ ok: false, message: "Movie not found" });

    res.json({ ok: true, data: movie });
  } catch (err) {
    console.error("[Movies] GET /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch movie", error: err.message });
  }
});

/* ------------------------------- Admin Routes ---------------------------- */
/* Use adminRouter and mount at /admin so /admin/* never gets captured by :id param */
const adminRouter = express.Router();

/**
 * GET /api/movies/admin/list
 * admin — returns all movies (protected)
 */
adminRouter.get("/list", async (req, res) => {
  try {
    const movies = await Movie.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, data: movies });
  } catch (err) {
    console.error("[Movies][Admin] GET /list error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch movies", error: err.message });
  }
});

/**
 * POST /api/movies/admin
 * create movie; accepts multipart form-data "poster" or JSON with posterUrl
 */
adminRouter.post("/", upload.single("poster"), async (req, res) => {
  try {
    const payload = req.body || {};

    // Normalize array-like fields: genres, cast, crew, languages
    const genres = normalizeToArray(payload.genres);
    const cast = normalizeToArray(payload.cast);
    const crew = normalizeToArray(payload.crew);
    let languages = normalizeToArray(payload.languages);

    // sensible default if languages not provided
    if (!languages || languages.length === 0) languages = ["English"];

    // map other scalar fields safely
    const doc = {
      title: payload.title ?? "",
      description: payload.description ?? payload.synopsis ?? "",
      director: payload.director ?? "",
      cast,
      crew,
      genres,
      languages,
      releasedAt: payload.releasedAt ? new Date(payload.releasedAt) : payload.releasedAt ?? null,
      inTheaters: typeof payload.inTheaters !== "undefined" ? payload.inTheaters === "true" || payload.inTheaters === true : false,
      runtimeMinutes: payload.runtimeMinutes ? Number(payload.runtimeMinutes) : payload.runtimeMinutes ? Number(payload.runtimeMinutes) : payload.runtime ?? null,
      posterUrl: payload.posterUrl ?? null,
      posterPublicId: payload.posterPublicId ?? null,
    };

    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movies";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        doc.posterUrl = result.secure_url;
        doc.posterPublicId = result.public_id;
      } catch (e) {
        console.error("[Movies][Admin] Cloudinary upload failed (create):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload poster", error: e?.message || String(e) });
      }
    }

    if (req.user) {
      doc.uploaderId = req.user.id || req.user._id || req.user.sub;
      doc.uploaderRole = req.user.role || "admin";
    }

    const created = await Movie.create(doc);
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    console.error("[Movies][Admin] POST / error:", err);
    res.status(500).json({ ok: false, message: "Failed to create movie", error: err.message });
  }
});

/**
 * PUT /api/movies/admin/:id
 * update movie, optional poster replace
 */
adminRouter.put("/:id([0-9a-fA-F]{24})", upload.single("poster"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const existing = await Movie.findById(id);
    if (!existing) return res.status(404).json({ ok: false, message: "Movie not found" });

    const body = req.body || {};

    // Normalize arrays (if present)
    const genres = body.genres ? normalizeToArray(body.genres) : existing.genres || [];
    const cast = body.cast ? normalizeToArray(body.cast) : existing.cast || [];
    const crew = body.crew ? normalizeToArray(body.crew) : existing.crew || [];
    const languages = body.languages ? normalizeToArray(body.languages) : existing.languages || ["English"];

    const payload = {
      title: body.title ?? existing.title,
      description: body.description ?? body.synopsis ?? existing.description,
      director: body.director ?? existing.director,
      cast,
      crew,
      genres,
      languages,
      releasedAt: body.releasedAt ? new Date(body.releasedAt) : existing.releasedAt,
      inTheaters: typeof body.inTheaters !== "undefined" ? (body.inTheaters === "true" || body.inTheaters === true) : existing.inTheaters,
      posterUrl: body.posterUrl ?? existing.posterUrl,
      posterPublicId: existing.posterPublicId,
      runtimeMinutes: body.runtimeMinutes ? Number(body.runtimeMinutes) : (body.runtime ? Number(body.runtime) : existing.runtimeMinutes),
    };

    let oldPosterRef = null;
    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movies";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
        oldPosterRef = existing.posterPublicId || existing.posterUrl;
      } catch (e) {
        console.error("[Movies][Admin] Cloudinary upload failed (update):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload poster", error: e?.message || String(e) });
      }
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();

    // best-effort delete old poster if changed
    if (updated && oldPosterRef && oldPosterRef !== (updated.posterPublicId || updated.posterUrl)) {
      try {
        if (typeof oldPosterRef === "string" && oldPosterRef.length) {
          await cloudinary.uploader.destroy(oldPosterRef);
          console.log("[Cloudinary] destroyed old poster:", oldPosterRef);
        }
      } catch (e) {
        console.warn("[Movies][Admin] failed to delete previous poster:", e?.message || e);
      }
    }

    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies][Admin] PUT /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to update movie", error: err.message });
  }
});

/**
 * DELETE /api/movies/admin/:id
 */
adminRouter.delete("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const deleted = await Movie.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ ok: false, message: "Movie not found" });

    if (deleted.posterPublicId) {
      try {
        await cloudinary.uploader.destroy(deleted.posterPublicId);
        console.log("[Cloudinary] deleted poster:", deleted.posterPublicId);
      } catch (err) {
        console.warn("[Cloudinary] Failed to delete poster:", err?.message || err);
      }
    }

    res.json({ ok: true, message: "Deleted", id: deleted._id });
  } catch (err) {
    console.error("[Movies][Admin] DELETE /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to delete movie", error: err.message });
  }
});

/* ----------------- mount adminRouter with auth ------------------ */
router.use("/admin", requireAuth, requireAdmin, adminRouter);

/* ----------------------- Multer error handler ---------------------------- */
router.use((err, _req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, message: "File too large (max 8MB)" });
    return res.status(400).json({ ok: false, message: err.message || "File upload error" });
  }
  next(err);
});

export default router;
