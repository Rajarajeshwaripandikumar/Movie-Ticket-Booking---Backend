// backend/src/routes/movies.routes.js
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

const MIME_EXT = {
  "image/jpeg": ".jpeg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

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
  const ok = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ].includes(file.mimetype);
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
  if (req.file) {
    const name = req.file.originalname || "(unnamed)";
    console.log("[uploads] buffer received:", name, "size:", req.file.size);
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
  return u && typeof u === "string" ? (u.startsWith("/") ? u : `/${u}`) : "";
};

const onlyUploads = (relish) => {
  const p = toRelativePoster(relish);
  return p.startsWith("/uploads/") ? p : "";
};

const toPublicUrl = (u) => {
  if (!u) return "";
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
    return s || null;
  } catch (e) {
    return null;
  }
}

async function deleteCloudinaryImageMaybe(ref) {
  if (!ref) return;
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
  safeUnlink(ref);
}

/* ---------------- helper: upload buffer to Cloudinary (DEBUG) -------------- */
function uploadBufferToCloudinaryDebug(buffer, folder = "movie-posters") {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => {
        const took = Date.now() - start;
        if (err) {
          console.error("[Cloudinary DEBUG] upload failed after", took, "ms");
          try {
            console.error("  err.message:", err.message);
            console.error("  err.http_code:", err.http_code);
            console.error("  err.http_body:", err.http_body);
            console.error("  err.stack:", err.stack ? err.stack.split("\n").slice(0,5).join("\n") : "");
          } catch (x) {
            console.error("[Cloudinary DEBUG] error printing error details:", x);
          }
          return reject(err);
        }
        console.log("[Cloudinary DEBUG] upload success after", took, "ms");
        console.log("  secure_url:", result.secure_url);
        console.log("  public_id :", result.public_id);
        resolve(result);
      }
    );

    try {
      streamifier.createReadStream(buffer).pipe(uploadStream);
    } catch (pipeErr) {
      console.error("[Cloudinary DEBUG] stream pipe error:", pipeErr);
      reject(pipeErr);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*                          Temporary test route (debug)                      */
/* -------------------------------------------------------------------------- */
/**
 * POST /api/movies/test-cloud
 * NO AUTH. Attempts to upload a public sample image into your Cloudinary account.
 * Use this to confirm the running process can reach Cloudinary and creds are correct.
 * Remove when finished debugging.
 */
router.post("/test-cloud", async (req, res) => {
  try {
    const sample = "https://res.cloudinary.com/demo/image/upload/sample.jpg";
    const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
    const result = await cloudinary.uploader.upload(sample, { folder, resource_type: "image" });
    return res.json({ ok: true, secure_url: result.secure_url, public_id: result.public_id, raw: result });
  } catch (err) {
    console.error("[test-cloud] error:", err);
    return res.status(500).json({
      ok: false,
      message: "Cloudinary test upload failed",
      error: err?.message,
      http_code: err?.http_code,
      http_body: err?.http_body,
    });
  }
});

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
/**
 * Accepts multipart/form-data with field "image" for poster file.
 */
router.post("/", requireAuth, requireAdmin, upload.single("image"), logUpload, async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.title || typeof payload.title !== "string") {
      return res.status(400).json({ message: "Title is required" });
    }

    payload.cast = castToStringArray(payload.cast);

    // If a file was uploaded -> stream to Cloudinary (debug uploader used)
    if (req.file) {
      try {
        console.log("[Movies] starting cloudinary upload (create) ...");
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await uploadBufferToCloudinaryDebug(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
        console.log("[Movies] cloudinary upload result (create):", result.secure_url, result.public_id);
      } catch (e) {
        // print any Cloudinary fields we can
        console.error("[Movies] cloudinary upload failed (create) - details:");
        console.error("  message:", e?.message);
        console.error("  http_code:", e?.http_code);
        console.error("  http_body:", e?.http_body);
        return res.status(500).json({ message: "Failed to upload poster", error: e?.message || e });
      }
    }

    // basic validation: durationMins numeric
    if (payload.durationMins !== undefined && payload.durationMins !== "") {
      const n = Number(payload.durationMins);
      if (Number.isNaN(n)) {
        if (payload.posterPublicId) {
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
    if (req.file && err && err.posterPublicId) {
      try {
        await deleteCloudinaryImageMaybe(err.posterPublicId);
      } catch {}
    }
    res.status(400).json({ message: "Failed to create movie", error: err.message });
  }
});

/* -------------------------- PUT: update (admin only) ---------------------- */
router.put("/:id", requireAuth, requireAdmin, upload.single("image"), logUpload, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ message: "Invalid movie id" });
    }

    const existing = await Movie.findById(id).lean();
    if (!existing) {
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
      posterUrl: b.posterUrl ?? existing.posterUrl,
      posterPublicId: existing.posterPublicId,
    };

    let oldPosterRef = null;
    if (req.file) {
      try {
        console.log("[Movies] starting cloudinary upload (update) ...");
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await uploadBufferToCloudinaryDebug(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
        oldPosterRef = existing.posterPublicId || existing.posterUrl;
        console.log("[Movies] cloudinary upload result (update):", result.secure_url, result.public_id);
      } catch (e) {
        console.error("[Movies] cloudinary upload failed (update) - details:");
        console.error("  message:", e?.message);
        console.error("  http_code:", e?.http_code);
        console.error("  http_body:", e?.http_body);
        return res.status(500).json({ message: "Failed to upload poster", error: e?.message || e });
      }
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();

    // If we replaced the poster, delete the old one (Cloudinary or local)
    if (updated && oldPosterRef) {
      const newRef = updated.posterPublicId || updated.posterUrl;
      if (oldPosterRef && oldPosterRef !== newRef) {
        try {
          await deleteCloudinaryImageMaybe(oldPosterRef);
        } catch (e) {
          console.warn("[Movies] failed to delete previous poster:", e?.message || e);
        }
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

    if (removed.posterPublicId) {
      await deleteCloudinaryImageMaybe(removed.posterPublicId);
    } else if (removed.posterUrl) {
      await deleteCloudinaryImageMaybe(removed.posterUrl);
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
