// routes/theaterRoutes.js
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

/**
 * Converts any amenity payload into a clean string array
 * Handles arrays, JSON array strings '["AC","Parking"]', or comma-separated strings 'AC,Parking'
 */
const toArray = (input) => {
  if (!input && input !== 0) return [];

  if (Array.isArray(input)) return input.map((v) => String(v).trim()).filter(Boolean);

  const s = String(input).trim();
  if (!s) return [];

  // Try JSON parse if looks like JSON array
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // fallthrough to comma-split
    }
  }

  // Fallback: comma separated
  return s.split(",").map((v) => v.trim()).filter(Boolean);
};

/* -------------------------------------------------------------------------- */
/*                                 Debug helpers                               */
/* -------------------------------------------------------------------------- */
const debugLog = (...args) => {
  if (process.env.NODE_ENV !== "production") console.log(...args);
};

/* -------------------------------------------------------------------------- */
/*                              Admin Routes (moved up)                       */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/theaters/admin/list
 * Admin — full list (protected)
 *
 * NOTE: this route is placed BEFORE the :id route to avoid being shadowed.
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
    debugLog("[TheaterCreate] parsed amenities:", payload.amenities);

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

    // Ensure amenities field exists and is an array
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

    debugLog(`[TheaterUpdate] id=${id} raw req.body:`, req.body);
    debugLog(`[TheaterUpdate] req.file present:`, !!req.file, "existing.imagePublicId:", existing.imagePublicId);

    // Merge - take care to prefer req.body values
    const payload = { ...existing.toObject(), ...req.body };

    payload.amenities = toArray(payload.amenities);
    debugLog("[TheaterUpdate] parsed amenities:", payload.amenities);

    if (req.file) {
      // delete previous image (optional)
      if (existing.imagePublicId) {
        try {
          await cloudinary.uploader.destroy(existing.imagePublicId);
        } catch (e) {
          console.warn("[Cloudinary] failed to delete old image:", e.message);
        }
      }
      const folder = process.env.CLOUDINARY_FOLDER || "theaters";
      const result = await uploadToCloudinary(req.file.buffer, folder);
      payload.imageUrl = result.secure_url;
      payload.imagePublicId = result.public_id;
    }

    // Ensure amenities is always an array
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
 * Admin — set amenities array directly (expects JSON body: { amenities: ["AC","Parking"] })
 * Useful for testing whether DB accepts the array properly.
 */
router.patch("/admin/:id/amenities", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

    const amenities = toArray(req.body?.amenities ?? req.body);
    debugLog("[PATCH amenities] id:", id, "incoming amenities:", amenities);

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
 *
 * Note: placed after admin routes so '/admin' isn't treated as an id.
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
      try {
        await cloudinary.uploader.destroy(deleted.imagePublicId);
      } catch (err) {
        console.warn("[Cloudinary] Failed to delete theater poster:", err.message);
      }
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
