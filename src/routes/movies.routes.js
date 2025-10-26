// backend/src/routes/theaters.routes.js
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/* ----------------------------- Helpers ---------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

const toArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String).map((s) => s.trim()).filter(Boolean) : v.split(",").map((s) => s.trim()).filter(Boolean);
    } catch {
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
};

function uploadBufferToCloudinary(buffer, folder = "theaters") {
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
      const rx = new RegExp(String(q), "i");
      filter.$or = [{ name: rx }, { city: rx }, { address: rx }];
    }
    if (city && city !== "All") filter.city = city;

    const safeLimit = Math.min(Number(limit) || 12, 1000);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [theaters, totalCount, cities] = await Promise.all([
      Theater.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(safeLimit).lean(),
      Theater.countDocuments(filter),
      Theater.distinct("city"),
    ]);

    // Attach screen counts
    const screenCounts = await Screen.aggregate([{ $group: { _id: "$theater", count: { $sum: 1 } } }]);
    const countMap = new Map(screenCounts.map((c) => [String(c._id), c.count]));

    const enriched = theaters.map((t) => ({
      ...t,
      screensCount: countMap.get(String(t._id)) || 0,
    }));

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
    res.status(500).json({ ok: false, message: "Failed to fetch theaters", error: err.message });
  }
});

/**
 * GET /api/theaters/:id
 * Single theater + screen count
 *
 * NOTE: param constrained to 24-hex ObjectId to avoid accidental matching of literal segments.
 */
router.get("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid theater id" });

    const theater = await Theater.findById(id).lean();
    if (!theater) return res.status(404).json({ ok: false, message: "Theater not found" });

    const screensCount = await Screen.countDocuments({ theater: new mongoose.Types.ObjectId(id) });
    res.json({ ok: true, data: { ...theater, screensCount } });
  } catch (err) {
    console.error("[Theaters] GET /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch theater", error: err.message });
  }
});

/**
 * GET /api/theaters/:theaterId/screens
 * List all screens for a theater
 *
 * param constrained to ObjectId
 */
router.get("/:theaterId([0-9a-fA-F]{24})/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isValidId(theaterId)) return res.status(400).json({ ok: false, error: "Invalid theater id" });

    const screens = await Screen.find({ theater: theaterId }).lean();
    res.json({ ok: true, data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /:theaterId/screens error:", err);
    res.status(500).json({ ok: false, error: "Failed to load screens", details: err.message });
  }
});

/* ------------------------------- Admin Routes ---------------------------- */
/* Use a dedicated adminRouter mounted at /admin so literal paths like /admin/list
   are never captured by param routes. Middleware applied to adminRouter protects all admin endpoints.
*/

const adminRouter = express.Router();

// Admin — full list
adminRouter.get("/list", async (req, res) => {
  try {
    const theaters = await Theater.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, data: theaters });
  } catch (err) {
    console.error("[Theaters][Admin] GET /list error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch theaters", error: err.message });
  }
});

/**
 * POST /api/theaters/admin
 * Admin — create with Cloudinary image
 * Accepts multipart/form-data with field "image" or regular JSON with posterUrl
 */
adminRouter.post("/", upload.single("image"), async (req, res) => {
  try {
    const payload = req.body || {};
    payload.amenities = toArray(payload.amenities);

    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "theaters";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.imageUrl = result.secure_url;
        payload.imagePublicId = result.public_id;
      } catch (e) {
        console.error("[Theaters][Admin] Cloudinary upload failed (create):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload image", error: e?.message || String(e) });
      }
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const created = await Theater.create(payload);
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    console.error("[Theaters][Admin] POST / error:", err);
    res.status(500).json({ ok: false, message: "Failed to create theater", error: err.message });
  }
});

/**
 * PUT /api/theaters/admin/:id
 * Admin — update + optional image replace
 */
adminRouter.put("/:id([0-9a-fA-F]{24})", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid theater ID" });

    const existing = await Theater.findById(id);
    if (!existing) return res.status(404).json({ ok: false, message: "Theater not found" });

    const body = req.body || {};
    const payload = {
      name: body.name ?? existing.name,
      city: body.city ?? existing.city,
      address: body.address ?? existing.address,
      amenities: body.amenities ? toArray(body.amenities) : existing.amenities,
      phone: body.phone ?? existing.phone,
      imageUrl: body.imageUrl ?? existing.imageUrl,
      imagePublicId: existing.imagePublicId,
    };

    let oldImageRef = null;
    if (req.file) {
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "theaters";
        const result = await uploadBufferToCloudinary(req.file.buffer, folder);
        payload.imageUrl = result.secure_url;
        payload.imagePublicId = result.public_id;
        oldImageRef = existing.imagePublicId || existing.imageUrl;
      } catch (e) {
        console.error("[Theaters][Admin] Cloudinary upload failed (update):", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload image", error: e?.message || String(e) });
      }
    }

    if (req.user) {
      payload.uploaderId = req.user.id || req.user._id || req.user.sub;
      payload.uploaderRole = req.user.role || "admin";
    }

    const updated = await Theater.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();

    // best-effort delete old image if replaced
    if (updated && oldImageRef && oldImageRef !== (updated.imagePublicId || updated.imageUrl)) {
      try {
        if (typeof oldImageRef === "string") {
          await cloudinary.uploader.destroy(oldImageRef);
          console.log("[Cloudinary] destroyed old image:", oldImageRef);
        }
      } catch (e) {
        console.warn("[Theaters][Admin] failed to delete previous image:", e?.message || e);
      }
    }

    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Theaters][Admin] PUT /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to update theater", error: err.message });
  }
});

/**
 * DELETE /api/theaters/admin/:id
 * Admin — delete + remove Cloudinary image
 */
adminRouter.delete("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid theater ID" });

    const deleted = await Theater.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ ok: false, message: "Theater not found" });

    if (deleted.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(deleted.imagePublicId);
        console.log("[Cloudinary] deleted:", deleted.imagePublicId);
      } catch (err) {
        console.warn("[Cloudinary] Failed to delete theater image:", err?.message || err);
      }
    }

    res.json({ ok: true, message: "Deleted", id: deleted._id });
  } catch (err) {
    console.error("[Theaters][Admin] DELETE /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to delete theater", error: err.message });
  }
});

/* ----------------- mount adminRouter with auth ------------------ */
// protect all admin routes
router.use("/admin", requireAuth, requireAdmin, adminRouter);

/* ----------------------- Multer error handler ---------------------------- */
router.use((err, _req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, message: "File too large (max 5MB)" });
    return res.status(400).json({ ok: false, message: err.message || "File upload error" });
  }
  next(err);
});

export default router;
