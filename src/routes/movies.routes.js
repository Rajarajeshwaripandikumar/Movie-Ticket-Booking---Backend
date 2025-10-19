import { Router } from "express";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import Movie from "../models/Movie.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import dotenv from "dotenv";

dotenv.config();
const router = Router();

/* -------------------------------------------------------------------------- */
/*                                CONFIG SETUP                                */
/* -------------------------------------------------------------------------- */
const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  "https://movie-ticket-booking-backend-o1m2.onrender.com";

const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";
const uploadDir = path.resolve(UPLOADS_DIR);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

/* -------------------------------------------------------------------------- */
/*                         Cloudinary configuration                           */
/* -------------------------------------------------------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* -------------------------------------------------------------------------- */
/*                                MULTER SETUP                                */
/* -------------------------------------------------------------------------- */
const memoryStorage = multer.memoryStorage();

const fileFilter = (_, file, cb) => {
  const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"].includes(file.mimetype);
  ok
    ? cb(null, true)
    : cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only image files are allowed"));
};

const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

function logUpload(req, _res, next) {
  if (req.file) console.log("[uploads] buffer received:", req.file.originalname, "size:", req.file.size);
  else console.log("[uploads] no file on this request");
  next();
}

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

function castToStringArray(anyCast) {
  if (!anyCast) return [];
  if (Array.isArray(anyCast)) return anyCast.map((c) => String(c).trim()).filter(Boolean);
  if (typeof anyCast === "string") return anyCast.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

const castResponseObjects = (anyCast) => castToStringArray(anyCast).map((name) => ({ actorName: name }));

/* -------------------------------------------------------------------------- */
/*                       Cloudinary Upload Utility                            */
/* -------------------------------------------------------------------------- */
function uploadBufferToCloudinary(buffer, folder = "movie-posters") {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", use_filename: true, unique_filename: true },
      (err, result) => {
        if (err) {
          console.error("[Cloudinary] upload failed:", err.message);
          return reject(err);
        }
        console.log("[Cloudinary] uploaded:", result.secure_url);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

/* -------------------------------------------------------------------------- */
/*                            PUBLIC ROUTES                                   */
/* -------------------------------------------------------------------------- */

// GET /api/movies
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const skip = Number(req.query.skip) || 0;
    const [docs, count] = await Promise.all([
      Movie.find().sort({ releaseDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Movie.countDocuments(),
    ]);
    res.json({
      movies: docs.map((m) => ({ ...m, cast: castResponseObjects(m.cast) })),
      count,
    });
  } catch (err) {
    console.error("[Movies] GET / error:", err);
    res.status(500).json({ message: "Failed to load movies", error: err.message });
  }
});

// GET /api/movies/search
router.get("/search", async (req, res) => {
  try {
    const { q, genre } = req.query;
    const filter = {};
    if (q) {
      const rx = new RegExp(q, "i");
      filter.$or = [{ title: rx }, { description: rx }, { director: rx }, { genre: rx }];
    }
    if (genre) filter.genre = { $in: genre.split(",") };

    const docs = await Movie.find(filter).sort({ releaseDate: -1 }).lean();
    res.json({ movies: docs.map((m) => ({ ...m, cast: castResponseObjects(m.cast) })) });
  } catch (err) {
    console.error("[Movies] search error:", err);
    res.status(500).json({ message: "Failed to search movies", error: err.message });
  }
});

// GET /api/movies/:id
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

/* -------------------------------------------------------------------------- */
/*                            ADMIN ROUTES (/admin)                           */
/* -------------------------------------------------------------------------- */

// POST /api/movies/admin — Create
router.post("/admin", requireAuth, requireAdmin, upload.single("image"), logUpload, async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.title) return res.status(400).json({ message: "Title is required" });

    payload.cast = castToStringArray(payload.cast);

    if (req.file) {
      const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
      const result = await uploadBufferToCloudinary(req.file.buffer, folder);
      payload.posterUrl = result.secure_url;
      payload.posterPublicId = result.public_id;
    }

    if (payload.durationMins) payload.durationMins = Number(payload.durationMins);

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id;
      payload.uploaderRole = req.user.role || "admin";
    }

    const movie = await Movie.create(payload);
    res.status(201).json({ ok: true, data: movie });
  } catch (err) {
    console.error("[Movies] POST /admin error:", err);
    res.status(500).json({ message: "Failed to create movie", error: err.message });
  }
});

// PUT /api/movies/admin/:id — Update
router.put("/admin/:id", requireAuth, requireAdmin, upload.single("image"), logUpload, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid movie id" });

    const existing = await Movie.findById(id).lean();
    if (!existing) return res.status(404).json({ message: "Movie not found" });

    const payload = { ...existing, ...req.body };
    payload.cast = castToStringArray(payload.cast);

    if (req.file) {
      const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
      const result = await uploadBufferToCloudinary(req.file.buffer, folder);
      payload.posterUrl = result.secure_url;
      payload.posterPublicId = result.public_id;
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies] PUT /admin/:id error:", err);
    res.status(500).json({ message: "Failed to update movie", error: err.message });
  }
});

// DELETE /api/movies/admin/:id — Delete
router.delete("/admin/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid movie id" });
    const deleted = await Movie.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ message: "Movie not found" });
    res.json({ ok: true, message: "Movie deleted", id });
  } catch (err) {
    console.error("[Movies] DELETE /admin/:id error:", err);
    res.status(500).json({ message: "Failed to delete movie", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                           Multer Error Handler                             */
/* -------------------------------------------------------------------------- */
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "File too large (max 3MB)" });
    return res.status(400).json({ message: err.message });
  }
  next(err);
});

export default router;
