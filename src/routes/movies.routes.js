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

/* Optional hint to server.js: mount under /api/movies */
router.routesPrefix = "/api/movies";

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
const upload = multer({ storage: memoryStorage, fileFilter, limits: { fileSize: 8 * 1024 * 1024 } });

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

/* Normalize body fields into arrays */
function normalizeArrayField(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => {
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
      return v;
    }).map((s) => (typeof s === "string" ? s.trim() : s)).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    } catch {
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (typeof value === "object") return [value];
  return [String(value).trim()].filter(Boolean);
}

/* Cast/Crew sanitizers */
function sanitizeCastArray(inputArr) {
  if (!Array.isArray(inputArr)) return [];
  return inputArr
    .map((entry) => {
      if (!entry && entry !== 0) return null;
      if (typeof entry === "string") return { name: entry.trim(), character: "" };
      if (Array.isArray(entry)) {
        const names = entry.map((x) => (typeof x === "string" ? x : x?.name || JSON.stringify(x))).filter(Boolean);
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
 * public — paginated, optional search, genre, inTheaters, status
 */
router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const { q, genre, page = 1, limit = 20, onlyInTheaters, status } = req.query;
    const filter = {};

    if (q) {
      const rx = new RegExp(String(q), "i");
      filter.$or = [
        { title: rx },
        { director: rx },
        { "cast.name": rx },
        { "crew.name": rx },
        { genres: rx },
        { languages: rx },
      ];
    }
    if (genre) filter.genres = { $in: [genre] };
    if (onlyInTheaters === "true" || onlyInTheaters === true) filter.inTheaters = true;
    if (status) filter.status = status;

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
 */
router.get("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const movie = await Movie.findById(id).lean();
    if (!movie) return res.status(404).json({ ok: false, message: "Movie not found" });

    res.json({ ok: true, data: movie, movie });
  } catch (err) {
    console.error("[Movies] GET /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch movie", error: err.message });
  }
});

/* ------------------------------- Admin Routes ---------------------------- */
/* adminRouter mounted at /admin and protected by requireAuth + requireAdmin */
const adminRouter = express.Router();

/**
 * GET /api/movies/admin/list
 * admin — returns all movies for SUPER_ADMIN OR theater-owned for THEATER_ADMIN
 */
adminRouter.get("/list", async (req, res) => {
  try {
    const q = {};
    if (req.user && req.user.role === "THEATER_ADMIN") {
      if (!req.user.theater) return res.status(403).json({ ok: false, message: "Your account is not linked to a theater" });
      q.theater = req.user.theater;
    }
    const movies = await Movie.find(q).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, data: movies });
  } catch (err) {
    console.error("[Movies][Admin] GET /list error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch movies", error: err.message });
  }
});

/**
 * POST /api/movies/admin
 * create movie; accepts multipart form-data "poster" or JSON with posterUrl
 * THEATER_ADMIN: movie is automatically assigned to their theater
 */
adminRouter.post("/", upload.single("poster"), async (req, res) => {
  try {
    const payload = req.body || {};

    const genres = normalizeArrayField(payload.genres);
    const rawCast = normalizeArrayField(payload.cast);
    const rawCrew = normalizeArrayField(payload.crew);
    let languages = normalizeArrayField(payload.languages);
    if (!languages || languages.length === 0) languages = ["English"];

    const doc = {
      title: payload.title ?? "",
      description: payload.description ?? payload.synopsis ?? "",
      synopsis: payload.synopsis ?? payload.description ?? "",
      director: payload.director ?? "",
      cast: sanitizeCastArray(rawCast),
      crew: sanitizeCrewArray(rawCrew),
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
      status: payload.status || "PUBLISHED",
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

    // Ownership enforcement for THEATER_ADMIN
    if (req.user && req.user.role === "THEATER_ADMIN") {
      if (!req.user.theater) return res.status(403).json({ ok: false, message: "Your account is not linked to a theater" });
      doc.theater = req.user.theater;
    } else if (payload.theater && isValidId(payload.theater)) {
      doc.theater = payload.theater;
    }

    // uploader metadata
    if (req.user) {
      doc.uploaderId = req.user.id || req.user._id || req.user.sub;
      doc.uploaderRole = req.user.role || "ADMIN";
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
 * THEATER_ADMIN may only update movies owned by their theater
 */
adminRouter.put("/:id([0-9a-fA-F]{24})", upload.single("poster"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const existing = await Movie.findById(id);
    if (!existing) return res.status(404).json({ ok: false, message: "Movie not found" });

    if (req.user && req.user.role === "THEATER_ADMIN") {
      if (!req.user.theater) return res.status(403).json({ ok: false, message: "Your account is not linked to a theater" });
      if (!existing.theater || String(existing.theater) !== String(req.user.theater)) {
        return res.status(403).json({ ok: false, message: "Forbidden — this movie is not owned by your theater" });
      }
    }

    const body = req.body || {};
    const genres = body.genres ? normalizeArrayField(body.genres) : existing.genres || [];
    const rawCast = body.cast ? normalizeArrayField(body.cast) : existing.cast || [];
    const rawCrew = body.crew ? normalizeArrayField(body.crew) : existing.crew || [];
    const languages = body.languages ? normalizeArrayField(body.languages) : existing.languages || ["English"];

    const payload = {
      title: body.title ?? existing.title,
      description: body.description ?? body.synopsis ?? existing.description,
      synopsis: body.synopsis ?? existing.synopsis,
      director: body.director ?? existing.director,
      cast: sanitizeCastArray(rawCast),
      crew: sanitizeCrewArray(rawCrew),
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
      status: body.status ?? existing.status,
    };

    let oldPosterPublicId = existing.posterPublicId || null;

    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movies";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.posterUrl = result.secure_url;
        payload.posterPublicId = result.public_id;
      } catch (e) {
        console.error("[Movies][Admin] Cloudinary upload failed (update):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload poster", error: e?.message || String(e) });
      }
    }

    // Prevent THEATER_ADMIN changing theater to other value
    if (req.user && req.user.role === "THEATER_ADMIN") {
      payload.theater = req.user.theater;
    } else if (body.theater && isValidId(body.theater)) {
      payload.theater = body.theater;
    }

    // uploader metadata
    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "ADMIN";
    }

    let updated;
    try {
      updated = await Movie.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    } catch (validationErr) {
      console.error("[Movies][Admin] Validation error on update:", validationErr);
      if (validationErr?.errors) {
        const details = Object.keys(validationErr.errors).map((k) => ({
          path: k,
          message: validationErr.errors[k].message,
        }));
        return res.status(400).json({ ok: false, message: "Validation failed", errors: details, raw: validationErr.message });
      }
      return res.status(500).json({ ok: false, message: "Failed to update movie", error: String(validationErr) });
    }

    // Cloudinary cleanup: destroy old poster only if we have safe public id
    if (updated && oldPosterPublicId && oldPosterPublicId !== (updated.posterPublicId || updated.posterUrl)) {
      try {
        await cloudinary.uploader.destroy(oldPosterPublicId);
        console.log("[Cloudinary] destroyed old poster:", oldPosterPublicId);
      } catch (e) {
        console.warn("[Movies][Admin] failed to delete previous poster (publicId):", e?.message || e);
      }
    } else if (oldPosterPublicId && !updated) {
      console.warn("[Movies][Admin] oldPosterPublicId present but update returned no doc; skipping destroy");
    } else if (!oldPosterPublicId && existing.posterUrl && existing.posterUrl !== updated?.posterUrl) {
      console.warn("[Movies][Admin] previous poster is a URL (no public id). Skipping cloudinary destroy to avoid accidental deletion.");
    }

    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Movies][Admin] PUT /:id error:", err && (err.stack || err.message || err));
    const shortStack = err?.stack ? String(err.stack).split("\n").slice(0, 6).join("\n") : undefined;
    return res.status(500).json({ ok: false, message: "Failed to update movie", error: err?.message || String(err), stack: shortStack });
  }
});

/**
 * DELETE /api/movies/admin/:id
 * THEATER_ADMIN may delete only owned movies
 */
adminRouter.delete("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid movie id" });

    const existing = await Movie.findById(id);
    if (!existing) return res.status(404).json({ ok: false, message: "Movie not found" });

    // THEATER_ADMIN check
    if (req.user && req.user.role === "THEATER_ADMIN") {
      if (!req.user.theater) return res.status(403).json({ ok: false, message: "Your account is not linked to a theater" });
      if (!existing.theater || String(existing.theater) !== String(req.user.theater)) {
        return res.status(403).json({ ok: false, message: "Forbidden — this movie is not owned by your theater" });
      }
    }

    const deleted = await Movie.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ ok: false, message: "Movie not found" });

    // delete poster if Cloudinary public id present
    if (deleted.posterPublicId) {
      try {
        await cloudinary.uploader.destroy(deleted.posterPublicId);
        console.log("[Cloudinary] deleted poster:", deleted.posterPublicId);
      } catch (err) {
        console.warn("[Cloudinary] Failed to delete poster:", err?.message || err);
      }
    } else if (deleted.posterUrl) {
      console.warn("[Movies][Admin] deleted movie had posterUrl but no posterPublicId — cannot safely destroy remote asset");
    }

    res.json({ ok: true, message: "Deleted", id: deleted._id });
  } catch (err) {
    console.error("[Movies][Admin] DELETE /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to delete movie", error: err.message });
  }
});

/* ----------------- mount adminRouter with auth + role guard ------------------ */
/**
 * Protect admin routes: must be authenticated and an admin (SUPER_ADMIN or THEATER_ADMIN)
 * requireAdmin should allow both super and theater admin (adjust detail inside middleware)
 */
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
