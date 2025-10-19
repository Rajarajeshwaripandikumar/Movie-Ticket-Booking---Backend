// backend/src/routes/theaters.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import Theater from "../models/Theater.js"; // create this model if missing
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import dotenv from "dotenv";

dotenv.config();
const router = Router();

/* Cloudinary */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* Multer */
const memoryStorage = multer.memoryStorage();
const fileFilter = (_, file, cb) => {
  const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype);
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

const isValidId = (id) => mongoose.isValidObjectId(id);
const toArray = (input) => {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((v) => String(v).trim());
  if (typeof input === "string") return input.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
};

/* GET /api/admin/theaters  (list) */
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const theaters = await Theater.find().sort({ createdAt: -1 }).lean();
    res.json({ data: theaters });
  } catch (err) {
    console.error("[Theaters] GET / error:", err);
    res.status(500).json({ message: "Failed to fetch theaters" });
  }
});

/* POST /api/admin/theaters  (create + optional image) */
router.post("/", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
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
    const created = await Theater.create(payload);
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    console.error("[Theaters] POST error:", err);
    res.status(500).json({ message: "Failed to create theater", error: err.message });
  }
});

/* PUT /api/admin/theaters/:id  (update + optional image replace) */
router.put("/:id", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

    const existing = await Theater.findById(id);
    if (!existing) return res.status(404).json({ message: "Theater not found" });

    const payload = { ...existing.toObject(), ...req.body };
    payload.amenities = toArray(payload.amenities);

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

    const updated = await Theater.findByIdAndUpdate(id, payload, { new: true, runValidators: true }).lean();
    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Theaters] PUT error:", err);
    res.status(500).json({ message: "Failed to update theater", error: err.message });
  }
});

/* DELETE /api/admin/theaters/:id */
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
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
    console.error("[Theaters] DELETE error:", err);
    res.status(500).json({ message: "Failed to delete theater", error: err.message });
  }
});

/* Multer error handler */
router.use((err, _req, res, next) => {
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "File too large (max 5MB)" });
    return res.status(400).json({ message: err.message });
  }
  next(err);
});

export default router;
