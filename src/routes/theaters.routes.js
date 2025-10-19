import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import Movie from "../models/Movie.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import dotenv from "dotenv";

dotenv.config();

const router = Router();

/* -------------------------------------------------------------------------- */
/*                               Cloudinary Setup                             */
/* -------------------------------------------------------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* -------------------------------------------------------------------------- */
/*                                  Multer                                    */
/* -------------------------------------------------------------------------- */
const memoryStorage = multer.memoryStorage();
const fileFilter = (_, file, cb) => {
  const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(
    file.mimetype
  );
  ok ? cb(null, true) : cb(new Error("Only image files are allowed"));
};
const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB max
});

/* -------------------------------------------------------------------------- */
/*                               Helper Functions                             */
/* -------------------------------------------------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

const toArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim());
  if (typeof value === "string")
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
};

const uploadBufferToCloudinary = (buffer, folder = "movie-posters") =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", use_filename: true, unique_filename: true },
      (err, result) => {
        if (err) {
          console.error("[Cloudinary] Upload failed:", err.message);
          return reject(err);
        }
        console.log("[Cloudinary] Uploaded:", result.secure_url);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });

/* -------------------------------------------------------------------------- */
/*                               Public Routes                                */
/* -------------------------------------------------------------------------- */

// GET /api/movies
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const skip = Number(req.query.skip) || 0;

    const [movies, count] = await Promise.all([
      Movie.find().sort({ releaseDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Movie.countDocuments(),
    ]);

    res.json({ ok: true, movies, count });
  } catch (err) {
    console.error("[Movies] GET / error:", err);
    res.status(500).json({ ok: false, message: "Failed to load movies" });
  }
});

// GET /api/movies/:id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie ID" });

    const movie = await Movie.findById(id).lean();
    if (!movie) return res.status(404).json({ ok: false, message: "Movie not found" });

    res.json({ ok: true, data: movie });
  } catch (err) {
    console.error("[Movies] GET /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch movie" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               Admin Routes                                 */
/* -------------------------------------------------------------------------- */
// Mounted in app.js as: app.use("/api/admin/movies", requireAuth, requireAdmin, moviesRoutes);

// POST /api/admin/movies
router.post("/", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.title) return res.status(400).json({ ok: false, message: "Title is required" });

    payload.cast = toArray(payload.cast);
    if (payload.durationMins) payload.durationMins = Number(payload.durationMins);

    // Upload to Cloudinary if image present
    if (req.file) {
      const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
      const result = await uploadBufferToCloudinary(req.file.buffer, folder);
      payload.posterUrl = result.secure_url;
      payload.posterPublicId = result.public_id;
    }

    // Audit info
    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id;
      payload.uploaderRole = req.user.role || "admin";
    }

    const movie = await Movie.create(payload);
    res.status(201).json({ ok: true, data: movie });
  } catch (err) {
    console.error("[Movies] POST error:", err);
    res.status(500).json({ ok: false, message: "Failed to create movie", error: err.message });
  }
});

// PUT /api/admin/movies/:id
router.put("/:id", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie ID" });

    const existing = await Movie.findById(id);
    if (!existing) return res.status(404).json({ ok: false, message: "Movie not found" });

    const payload = { ...req.body };
    payload.cast = toArray(payload.cast);

    // Cloudinary upload if image file present
    if (req.file) {
      const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
      const result = await uploadBufferToCloudinary(req.file.buffer, folder);
      payload.posterUrl = result.secure_url;
      payload.posterPublicId = result.public_id;
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies] PUT error:", err);
    res.status(500).json({ ok: false, message: "Failed to update movie", error: err.message });
  }
});

// DELETE /api/admin/movies/:id
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie ID" });

    const deleted = await Movie.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ ok: false, message: "Movie not found" });

    // Delete image from Cloudinary if exists
    if (deleted.posterPublicId) {
      try {
        await cloudinary.uploader.destroy(deleted.posterPublicId);
        console.log("[Cloudinary] Deleted:", deleted.posterPublicId);
      } catch (e) {
        console.warn("[Cloudinary] Failed to delete:", e?.message);
      }
    }

    res.json({ ok: true, message: "Movie deleted successfully", id });
  } catch (err) {
    console.error("[Movies] DELETE error:", err);
    res.status(500).json({ ok: false, message: "Failed to delete movie", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                            Multer Error Handler                            */
/* -------------------------------------------------------------------------- */
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ ok: false, message: "File too large (max 3MB)" });
    return res.status(400).json({ ok: false, message: err.message });
  }
  next(err);
});

export default router;
