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
 * Normalize a request body field into an array.
 * - If value is an Array of primitives => array of trimmed strings
 * - If value is an Array of objects => return as-is (preserve object shape)
 * - If value is a JSON string representing an array (of primitives or objects) => parsed and normalized
 * - If value is a comma-separated string => split into trimmed strings
 * - If null/undefined/empty => []
 */
function normalizeArrayField(value) {
  if (value == null) return [];

  // If already an array, inspect its elements
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    // If array contains objects (cast objects), preserve them (but parse JSON strings inside)
    if (typeof value[0] === "object" && value[0] !== null) {
      return value.map((v) => {
        // if any array entry is a stringified JSON, try to parse
        if (typeof v === "string") {
          try {
            return JSON.parse(v);
          } catch (e) {
            return v;
          }
        }
        return v;
      });
    }
    // otherwise convert primitives to trimmed strings
    return value.map((s) => String(s).trim()).filter(Boolean);
  }

  // If a string, try JSON parse first
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    // try parsing JSON
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // if parsed array contains objects, return as-is
        if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
          return parsed;
        }
        // otherwise return trimmed primitives as strings
        return parsed.map((s) => String(s).trim()).filter(Boolean);
      }
    } catch (e) {
      // not JSON — fallthrough to comma-split
    }

    // comma-separated fallback
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // If it's an object (single object) — return as single-element array
  if (typeof value === "object") return [value];

  // fallback scalar => single-string array
  return [String(value).trim()].filter(Boolean);
}

/* --------------------- Defensive sanitizers for cast/crew ----------------- */
function sanitizeCastArray(inputArr) {
  if (!Array.isArray(inputArr)) return [];

  return inputArr
    .map((entry) => {
      if (!entry && entry !== 0) return null;

      if (typeof entry === "string") {
        return { name: entry.trim(), character: "" };
      }

      if (Array.isArray(entry)) {
        const names = entry
          .map((x) => (typeof x === "string" ? x : x?.name || x?.actorName || JSON.stringify(x)))
          .filter(Boolean);
        return { name: names.join(", "), character: "" };
      }

      if (typeof entry === "object") {
        const name =
          entry.name ||
          entry.actorName ||
          (entry.actor && (entry.actor.name || entry.actor.fullName)) ||
          (entry.person && (entry.person.name || entry.person.fullName)) ||
          "";
        const character = entry.character ?? entry.role ?? "";
        return { name: String(name || "").trim(), character: String(character || "").trim() };
      }

      return { name: String(entry), character: "" };
    })
    .filter((x) => x && (String(x.name).trim().length > 0 || String(x.character).trim().length > 0));
}

function sanitizeCrewArray(inputArr) {
  if (!Array.isArray(inputArr)) return [];

  return inputArr
    .map((entry) => {
      if (!entry && entry !== 0) return null;
      if (typeof entry === "string") return { name: entry.trim(), role: "" };
      if (Array.isArray(entry)) {
        const names = entry.map((x) => (typeof x === "string" ? x : x?.name || JSON.stringify(x))).filter(Boolean);
        return { name: names.join(", "), role: "" };
      }
      if (typeof entry === "object") {
        const name = entry.name || entry.fullName || (entry.person && (entry.person.name || entry.person.fullName)) || "";
        const role = entry.role || entry.job || "";
        return { name: String(name || "").trim(), role: String(role || "").trim() };
      }
      return { name: String(entry), role: "" };
    })
    .filter((x) => x && (String(x.name).trim().length > 0 || String(x.role).trim().length > 0));
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
    const genres = normalizeArrayField(payload.genres);
    const cast = normalizeArrayField(payload.cast);
    const crew = normalizeArrayField(payload.crew);
    let languages = normalizeArrayField(payload.languages);

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
      inTheaters:
        typeof payload.inTheaters !== "undefined"
          ? payload.inTheaters === "true" || payload.inTheaters === true
          : false,
      runtimeMinutes:
        payload.runtimeMinutes ? Number(payload.runtimeMinutes) : payload.runtime ? Number(payload.runtime) : null,
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
 *
 * This handler normalizes incoming cast/crew data into predictable plain objects,
 * runs validation, and returns clearer validation errors when possible.
 */
adminRouter.put("/:id([0-9a-fA-F]{24})", upload.single("poster"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    // Debug log
    console.log(`[Movies][Admin] PUT start id=${id} user=${req.user?.id || "anon"}`);

    const existing = await Movie.findById(id);
    if (!existing) {
      console.warn(`[Movies][Admin] PUT movie not found id=${id}`);
      return res.status(404).json({ ok: false, message: "Movie not found" });
    }

    const body = req.body || {};
    console.log("[Movies][Admin] incoming body keys:", Object.keys(body));

    // Normalize arrays (if present). If not present, keep existing values.
    const genres = body.genres ? normalizeArrayField(body.genres) : existing.genres || [];
    const rawCast = body.cast ? normalizeArrayField(body.cast) : existing.cast || [];
    const rawCrew = body.crew ? normalizeArrayField(body.crew) : existing.crew || [];
    const languages = body.languages ? normalizeArrayField(body.languages) : existing.languages || ["English"];

    console.log("[Movies][Admin] normalized: genresLen=", genres.length, "rawCastSample=", JSON.stringify(rawCast?.slice(0,3)));
    console.log("[Movies][Admin] normalized: rawCrewSample=", JSON.stringify(rawCrew?.slice(0,3)), "languages=", languages);

    // Sanitize cast/crew into predictable plain object shapes
    const cast = sanitizeCastArray(rawCast);
    const crew = sanitizeCrewArray(rawCrew);

    console.log("[Movies][Admin] sanitized cast sample:", JSON.stringify(cast?.slice(0,3)));
    console.log("[Movies][Admin] sanitized crew sample:", JSON.stringify(crew?.slice(0,3)));

    const payload = {
      title: body.title ?? existing.title,
      description: body.description ?? body.synopsis ?? existing.description,
      director: body.director ?? existing.director,
      cast,
      crew,
      genres,
      languages,
      releasedAt: body.releasedAt ? new Date(body.releasedAt) : existing.releasedAt,
      inTheaters:
        typeof body.inTheaters !== "undefined"
          ? body.inTheaters === "true" || body.inTheaters === true
          : existing.inTheaters,
      posterUrl: body.posterUrl ?? existing.posterUrl,
      posterPublicId: existing.posterPublicId,
      runtimeMinutes:
        body.runtimeMinutes ? Number(body.runtimeMinutes) : body.runtime ? Number(body.runtime) : existing.runtimeMinutes,
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

    console.log("[Movies][Admin] update payload preview:", {
      title: payload.title,
      genresCount: (payload.genres || []).length,
      castCount: (payload.cast || []).length,
      crewCount: (payload.crew || []).length,
      posterUrlPreview: payload.posterUrl ? String(payload.posterUrl).slice(0, 80) : null,
    });

    // Attempt update with validation; capture validation errors for clearer logs
    let updated;
    try {
      updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    } catch (validationErr) {
      console.error("[Movies][Admin] Validation error on update:", validationErr);
      if (validationErr && validationErr.errors) {
        const details = Object.keys(validationErr.errors).map((k) => ({
          path: k,
          message: validationErr.errors[k].message,
        }));
        return res.status(400).json({ ok: false, message: "Validation failed", errors: details, raw: validationErr.message });
      }
      return res.status(500).json({ ok: false, message: "Failed to update movie", error: String(validationErr) });
    }

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

    console.log(`[Movies][Admin] updated movie id=${id} success`);
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies][Admin] PUT /:id error:", err && (err.stack || err.message || err));
    const shortStack = err?.stack ? String(err.stack).split("\n").slice(0, 6).join("\n") : undefined;
    return res.status(500).json({ ok: false, message: "Failed to update movie", error: err?.message || String(err), stack: shortStack });
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
