// backend/src/routes/theaterRoutes.js
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

dotenv.config();
const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                        Cloudinary Configuration                            */
/* -------------------------------------------------------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* -------------------------------------------------------------------------- */
/*                              Multer + Stream                               */
/* -------------------------------------------------------------------------- */
const memoryStorage = multer.memoryStorage();
const fileFilter = (_, file, cb) => {
  const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"].includes(file.mimetype);
  ok ? cb(null, true) : cb(new Error("Only image files are allowed"));
};
const upload = multer({ storage: memoryStorage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

const uploadToCloudinary = (buffer, folder = "theaters") =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", use_filename: true, unique_filename: true },
      (err, result) => {
        if (err) {
          console.error("[Cloudinary] Upload failed:", err.message);
          return reject(err);
        }
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });

/* -------------------------------------------------------------------------- */
/*                               Utility Helpers                              */
/* -------------------------------------------------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

const toArray = (input) => {
  if (!input && input !== 0) return [];
  if (Array.isArray(input)) return input.map((v) => String(v).trim()).filter(Boolean);
  const s = String(input).trim();
  if (!s) return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {}
  }
  return s.split(",").map((v) => v.trim()).filter(Boolean);
};

const debugLog = (...args) => {
  if (process.env.NODE_ENV !== "production") console.log(...args);
};

/* -------------------------------------------------------------------------- */
/*                     Theatre Admin: self-scoped (by token)                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/theaters/me
 * Return the current manager's theatre (via req.user.theatreId)
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const theater = await Theater.findById(theatreId).lean();
    if (!theater) return res.status(404).json({ message: "Theatre not found" });

    const screensCount = await Screen.countDocuments({ theater: new mongoose.Types.ObjectId(theatreId) });
    return res.json({ ...theater, screensCount });
  } catch (err) {
    console.error("[Theaters] GET /me error:", err);
    return res.status(500).json({ message: "Failed to fetch theatre" });
  }
});

/**
 * GET /api/theaters/me/screens
 * Screens for the current manager's theatre
 */
router.get("/me/screens", requireAuth, async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const screens = await Screen.find({ theater: theatreId }).lean();
    return res.json({ data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /me/screens error:", err);
    return res.status(500).json({ message: "Failed to load screens" });
  }
});

/**
 * GET /api/theaters/me/summary
 * Lightweight counts for dashboard cards
 */
router.get("/me/summary", requireAuth, async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const [theater, screensCount] = await Promise.all([
      Theater.findById(theatreId).select("name city updatedAt").lean(),
      Screen.countDocuments({ theater: theatreId }),
    ]);
    if (!theater) return res.status(404).json({ message: "Theatre not found" });

    return res.json({
      name: theater.name,
      city: theater.city,
      screensCount,
      updatedAt: theater.updatedAt,
    });
  } catch (err) {
    console.error("[Theaters] GET /me/summary error:", err);
    return res.status(500).json({ message: "Failed to load summary" });
  }
});

/* -------------------------------------------------------------------------- */
/*                              Admin Routes                                   */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/theaters/admin/list
 * Admin — full list (protected)
 */
router.get("/admin/list", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const theaters = await Theater.find().sort({ createdAt: -1 }).lean();
    res.json({ data: theaters });
  } catch (err) {
    console.error("[Theaters] GET /admin/list error:", err);
    res.status(500).json({ message: "Failed to fetch theaters" });
  }
});

/**
 * POST /api/theaters/admin
 * Admin — create with Cloudinary image
 */
router.post("/admin", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    debugLog("[TheaterCreate] raw req.body:", req.body);
    debugLog("[TheaterCreate] req.file present:", !!req.file);

    const payload = req.body || {};
    payload.amenities = toArray(payload.amenities);

    if (req.file) {
      const folder = process.env.CLOUDINARY_FOLDER || "theaters";
      const result = await uploadToCloudinary(req.file.buffer, folder);
      payload.imageUrl = result.secure_url;
      payload.imagePublicId = result.public_id;
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id;
      payload.uploaderRole = req.user.role || "admin";
    }

    if (!Array.isArray(payload.amenities)) payload.amenities = [];

    const created = await Theater.create(payload);
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    console.error("[Theaters] POST /admin error:", err);
    res.status(500).json({ message: "Failed to create theater", error: err.message });
  }
});

/**
 * PUT /api/theaters/admin/:id
 * Admin — update + optional image replace
 */
router.put("/admin/:id", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

    const existing = await Theater.findById(id);
    if (!existing) return res.status(404).json({ message: "Theater not found" });

    const payload = { ...existing.toObject(), ...req.body };
    payload.amenities = toArray(payload.amenities);

    if (req.file) {
      if (existing.imagePublicId) {
        try { await cloudinary.uploader.destroy(existing.imagePublicId); }
        catch (e) { console.warn("[Cloudinary] failed to delete old image:", e.message); }
      }
      const folder = process.env.CLOUDINARY_FOLDER || "theaters";
      const result = await uploadToCloudinary(req.file.buffer, folder);
      payload.imageUrl = result.secure_url;
      payload.imagePublicId = result.public_id;
    }

    if (!Array.isArray(payload.amenities)) payload.amenities = [];

    const updated = await Theater.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).lean();

    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Theaters] PUT /admin/:id error:", err);
    res.status(500).json({ message: "Failed to update theater", error: err.message });
  }
});

/**
 * PATCH /api/theaters/admin/:id/amenities
 * Admin — set amenities array directly
 */
router.patch("/admin/:id/amenities", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

    const amenities = toArray(req.body?.amenities ?? req.body);
    const updated = await Theater.findByIdAndUpdate(
      id,
      { $set: { amenities } },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ message: "Theater not found" });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Theaters] PATCH /admin/:id/amenities error:", err);
    res.status(500).json({ message: "Failed to update amenities", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                                   Routes (public)                          */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/theaters
 * Public endpoint — paginated list for users
 */
router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const { q, city, page = 1, limit = 12 } = req.query;
    const filter = {};

    if (q) {
      filter.$or = [
        { name: new RegExp(q, "i") },
        { city: new RegExp(q, "i") },
        { address: new RegExp(q, "i") },
      ];
    }
    if (city && city !== "All") filter.city = city;

    const safeLimit = Math.min(Number(limit) || 12, 1000);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [theaters, totalCount, cities] = await Promise.all([
      Theater.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Theater.countDocuments(filter),
      Theater.distinct("city"),
    ]);

    // Attach screen counts
    const screenCounts = await Screen.aggregate([{ $group: { _id: "$theater", count: { $sum: 1 } } }]);
    const countMap = new Map(screenCounts.map((c) => [String(c._id), c.count]));
    const enriched = theaters.map((t) => ({ ...t, screensCount: countMap.get(String(t._id)) || 0 }));

    res.json({
      ok: true,
      theaters: enriched,
      count: totalCount,
      cities,
      page: safePage,
      limit: safeLimit,
      hasMore: skip + enriched.length < totalCount,
    });
  } catch (err) {
    console.error("[Theaters] GET / error:", err);
    res.status(500).json({ message: "Failed to fetch theaters" });
  }
});

/**
 * GET /api/theaters/:id
 * Single theater + screen count
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater id" });

    const theater = await Theater.findById(id).lean();
    if (!theater) return res.status(404).json({ message: "Theater not found" });

    const screensCount = await Screen.countDocuments({ theater: new mongoose.Types.ObjectId(id) });
    res.json({ ...theater, screensCount });
  } catch (err) {
    console.error("[Theaters] GET /:id error:", err);
    res.status(500).json({ message: "Failed to fetch theater" });
  }
});

/**
 * GET /api/theaters/:theaterId/screens
 * List all screens for a theater
 */
router.get("/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isValidId(theaterId)) return res.status(400).json({ error: "Invalid theater id" });

    const screens = await Screen.find({ theater: theaterId }).lean();
    res.json({ data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /:theaterId/screens error:", err);
    res.status(500).json({ error: "Failed to load screens" });
  }
});

/* -------------------------------------------------------------------------- */
/*                              Delete Route                                   */
/* -------------------------------------------------------------------------- */
router.delete("/admin/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

    const deleted = await Theater.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Theater not found" });

    if (deleted.imagePublicId) {
      try { await cloudinary.uploader.destroy(deleted.imagePublicId); }
      catch (err) { console.warn("[Cloudinary] Failed to delete theater poster:", err.message); }
    }

    res.json({ ok: true, message: "Deleted", id });
  } catch (err) {
    console.error("[Theaters] DELETE /admin/:id error:", err);
    res.status(500).json({ message: "Failed to delete theater", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                              Multer Error Handler                          */
/* -------------------------------------------------------------------------- */
router.use((err, _req, res, next) => {
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "File too large (max 5MB)" });
    return res.status(400).json({ message: err.message });
  }
  next(err);
});

export default router;
