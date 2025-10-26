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
      filter.$or = [{ title: rx }, { director: rx }, { cast: rx }, { genres: rx }];
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

    // normalize arrays if sent as JSON strings
    if (payload.genres && typeof payload.genres === "string") {
      try {
        payload.genres = JSON.parse(payload.genres);
      } catch {
        payload.genres = payload.genres.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }

    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movies";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
      } catch (e) {
        console.error("[Movies][Admin] Cloudinary upload failed (create):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload poster", error: e?.message || String(e) });
      }
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const created = await Movie.create(payload);
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
    const payload = {
      title: body.title ?? existing.title,
      description: body.description ?? existing.description,
      director: body.director ?? existing.director,
      cast: body.cast ? (Array.isArray(body.cast) ? body.cast : String(body.cast).split(",").map(s => s.trim())) : existing.cast,
      genres: body.genres ? (Array.isArray(body.genres) ? body.genres : String(body.genres).split(",").map(s => s.trim())) : existing.genres,
      releasedAt: body.releasedAt ?? existing.releasedAt,
      inTheaters: typeof body.inTheaters !== "undefined" ? body.inTheaters : existing.inTheaters,
      posterUrl: body.posterUrl ?? existing.posterUrl,
      posterPublicId: existing.posterPublicId,
      runtimeMinutes: body.runtimeMinutes ?? existing.runtimeMinutes,
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

    // best-effort delete old poster
    if (updated && oldPosterRef && oldPosterRef !== (updated.posterPublicId || updated.posterUrl)) {
      try {
        if (typeof oldPosterRef === "string") {
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
