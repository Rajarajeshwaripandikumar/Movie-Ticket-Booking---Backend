// backend/src/routes/movies.routes.js
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

/* --------------------------- Cloudinary config --------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* ------------------------------ Multer ---------------------------------- */
const memoryStorage = multer.memoryStorage();
const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

const fileFilter = (_, file, cb) => {
  const ok = allowedMimes.includes(file.mimetype);
  ok ? cb(null, true) : cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only image files are allowed"));
};

const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
});

/* ----------------------------- Helpers ---------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

const toArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    try {
      // attempt JSON parse (frontend may send JSON)
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String).map((s) => s.trim()).filter(Boolean) : v.split(",").map((s) => s.trim()).filter(Boolean);
    } catch {
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
};

const castToStringArray = (anyCast) => toArray(anyCast);

/* -------------------- Cloudinary buffer uploader ------------------------ */
function uploadBufferToCloudinary(buffer, folder = "movie-posters") {
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

/* ----------------------------- PUBLIC API -------------------------------- */

// GET /            -> list movies (limit/skip)
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const skip = Number(req.query.skip) || 0;

    const [docs, count] = await Promise.all([
      Movie.find().sort({ releaseDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Movie.countDocuments(),
    ]);

    res.json({ ok: true, movies: docs, count });
  } catch (err) {
    console.error("[Movies] GET / error:", err);
    res.status(500).json({ ok: false, message: "Failed to load movies", error: err.message });
  }
});

// GET /search?q=...&genre=...&limit=50
router.get("/search", async (req, res) => {
  try {
    const { q, genre, limit = 50 } = req.query;
    const filter = {};
    if (q) {
      const rx = new RegExp(q, "i");
      filter.$or = [{ title: rx }, { description: rx }, { director: rx }, { cast: rx }, { genre: rx }];
    }
    if (genre) {
      const g = toArray(genre);
      if (g.length) filter.genre = { $in: g };
    }
    const docs = await Movie.find(filter).sort({ releaseDate: -1, createdAt: -1 }).limit(Math.min(200, Number(limit))).lean();
    res.json({ ok: true, movies: docs, count: docs.length });
  } catch (err) {
    console.error("[Movies] GET /search error:", err);
    res.status(500).json({ ok: false, message: "Failed to search movies", error: err.message });
  }
});

// GET /:id
router.get("/:id", async (req, res) => {
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

/* ---------------------------- ADMIN ROUTES ------------------------------- */
/* These routes are protected by requireAuth + requireAdmin when mounted at
   /api/admin/movies (recommended). We also expose them under /admin/* so the
   same router can be mounted on /api/movies and still provide admin paths. */

/* POST /           (admin) create movie
   Accepts multipart form-data with field "image" (binary) or posterUrl string */
router.post("/", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.title || typeof payload.title !== "string") {
      return res.status(400).json({ ok: false, message: "Title is required" });
    }

    payload.cast = castToStringArray(payload.cast);

    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
      } catch (e) {
        console.error("[Movies] Cloudinary upload failed (create):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload poster", error: e?.message || e });
      }
    }

    if (payload.durationMins !== undefined && payload.durationMins !== "") {
      const n = Number(payload.durationMins);
      if (Number.isNaN(n)) return res.status(400).json({ ok: false, message: "durationMins must be a number" });
      payload.durationMins = n;
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const movie = await Movie.create(payload);
    res.status(201).json({ ok: true, data: movie });
  } catch (err) {
    console.error("[Movies] POST / error:", err);
    res.status(500).json({ ok: false, message: "Failed to create movie", error: err.message });
  }
});

// PUT /:id  (admin) update movie (supports multipart image)
router.put("/:id", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const existing = await Movie.findById(id).lean();
    if (!existing) return res.status(404).json({ ok: false, message: "Movie not found" });

    const body = req.body || {};
    const payload = {
      title: body.title ?? existing.title,
      description: body.description ?? existing.description,
      genre: body.genre ?? existing.genre,
      language: body.language ?? existing.language,
      director: body.director ?? existing.director,
      rating: body.rating ?? existing.rating,
      durationMins: body.durationMins ?? existing.durationMins,
      releaseDate: body.releaseDate ?? existing.releaseDate,
      cast: body.cast ? castToStringArray(body.cast) : existing.cast,
      posterUrl: body.posterUrl ?? existing.posterUrl,
      posterPublicId: existing.posterPublicId,
    };

    let oldPosterRef = null;
    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
        oldPosterRef = existing.posterPublicId || existing.posterUrl;
      } catch (e) {
        console.error("[Movies] Cloudinary upload failed (update):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload poster", error: e?.message || e });
      }
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();

    // optionally delete old poster (best-effort)
    if (updated && oldPosterRef && oldPosterRef !== (updated.posterPublicId || updated.posterUrl)) {
      try {
        const maybeId = typeof oldPosterRef === "string" ? oldPosterRef : null;
        // try destroy by public_id if it looks like one (cloudinary will ignore otherwise)
        if (maybeId) {
          try { await cloudinary.uploader.destroy(maybeId); console.log("[Cloudinary] destroyed old:", maybeId); } catch {}
        }
      } catch (e) {
        console.warn("[Movies] failed to delete previous poster:", e?.message || e);
      }
    }

    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies] PUT /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to update movie", error: err.message });
  }
});

// DELETE /:id (admin)
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const removed = await Movie.findByIdAndDelete(id).lean();
    if (!removed) return res.status(404).json({ ok: false, message: "Movie not found" });

    // best-effort delete from Cloudinary if posterPublicId exists
    if (removed.posterPublicId) {
      try {
        await cloudinary.uploader.destroy(removed.posterPublicId);
        console.log("[Cloudinary] deleted:", removed.posterPublicId);
      } catch (e) {
        console.warn("[Cloudinary] failed to delete:", e?.message || e);
      }
    }

    res.json({ ok: true, message: "Movie deleted", id: removed._id });
  } catch (err) {
    console.error("[Movies] DELETE /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to delete movie", error: err.message });
  }
});

/* ------------------------ Admin-prefixed routes --------------------------- */
/* These make the same admin handlers accessible under /admin/* when the router
   is mounted at /api/movies (so both mounting styles work). */

router.post("/admin", requireAuth, requireAdmin, upload.single("image"), async (req, res, next) => {
  // forward to the same create handler above
  req.url = "/"; // set to root so the first POST "/" handler runs
  return router.handle(req, res, next);
});

router.put("/admin/:id", requireAuth, requireAdmin, upload.single("image"), async (req, res, next) => {
  req.url = `/${req.params.id}`;
  return router.handle(req, res, next);
});

router.delete("/admin/:id", requireAuth, requireAdmin, async (req, res, next) => {
  req.url = `/${req.params.id}`;
  return router.handle(req, res, next);
});

/* ----------------------- Multer error handler ---------------------------- */
router.use((err, _req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, message: "File too large (max 3MB)" });
    return res.status(400).json({ ok: false, message: err.message || "File upload error" });
  }
  next(err);
});

export default router;
