// backend/src/routes/theaters.routes.js
import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                        Cloudinary configuration                             */
/* -------------------------------------------------------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* -------------------------------------------------------------------------- */
/*                               Multer setup                                 */
/* -------------------------------------------------------------------------- */
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

const fileFilter = (_, file, cb) => {
  const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype);
  if (ok) return cb(null, true);
  const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
  err.message = "Only image files are allowed";
  cb(err);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */
const isId = (id) => mongoose.isValidObjectId(id);
const toLower = (v) => String(v || "").trim().toLowerCase();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const safeUnlink = (rel) => {
  try {
    if (!rel) return;
    const relClean = rel.startsWith("/") ? rel.slice(1) : rel;
    const abs = path.join(process.cwd(), relClean);
    const normalizedUploadDir = path.resolve(uploadDir) + path.sep;
    const normalizedAbs = path.resolve(abs);
    if (!normalizedAbs.startsWith(normalizedUploadDir)) {
      console.warn("[safeUnlink] refused to unlink outside uploadDir:", abs);
      return;
    }
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) {
    console.warn("[safeUnlink] error:", e?.message || e);
  }
};

/* Extract Cloudinary public_id from URL or accept a public_id */
function extractPublicId(urlOrId) {
  if (!urlOrId) return null;
  try {
    const s = String(urlOrId).trim();
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const p = u.pathname;
      const idx = p.indexOf("/upload/");
      if (idx >= 0) {
        let after = p.slice(idx + "/upload/".length);
        // remove version like v12345/
        after = after.replace(/^v\d+\//, "");
        // strip extension
        after = after.replace(/\.[a-z0-9]+$/i, "");
        return after;
      }
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

/* Delete a Cloudinary image if the ref is a cloudinary id/url */
async function deleteCloudImageIfAny(ref) {
  if (!ref) return;
  const publicId = extractPublicId(ref);
  if (!publicId) {
    // maybe local path; try to unlink
    safeUnlink(ref);
    return;
  }
  try {
    const res = await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    console.log("[Cloudinary] destroy result:", publicId, res);
  } catch (e) {
    console.warn("[Cloudinary] destroy failed for", publicId, e?.message || e);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers (db)                              */
/* -------------------------------------------------------------------------- */
// find existing theater by case-insensitive name+city (fast path uses lower fields)
async function findExistingTheaterByNameCity(name, city) {
  const nameLower = toLower(name);
  const cityLower = toLower(city);

  let existing = await Theater.findOne({ nameLower, cityLower }).lean();
  if (existing) return existing;

  // legacy fallback: case-insensitive regex
  existing = await Theater.findOne({
    name: { $regex: `^${esc(name)}$`, $options: "i" },
    city: { $regex: `^${esc(city)}$`, $options: "i" },
  }).lean();
  return existing;
}

/* -------------------------------------------------------------------------- */
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/theaters
 * Create new theater (accepts multipart `image` or JSON `imageUrl`)
 * Idempotent pre-check by (name, city)
 *
 * NOTE: consider adding `requireAuth, requireAdmin` to protect this endpoint.
 */
router.post("/", upload.single("image"), async (req, res) => {
  const uploadedImagePath = req.file ? `/uploads/${req.file.filename}` : "";
  const cleanupNewUpload = () => { if (req.file) safeUnlink(`/uploads/${req.file.filename}`); };

  try {
    const { name, address = "", city, amenities = "", screens = 1, imageUrl: bodyImageUrl = "" } = req.body;

    if (!name || !city) {
      cleanupNewUpload();
      return res.status(400).json({ ok: false, error: "Name and city are required" });
    }

    // Idempotency pre-check
    const dup = await findExistingTheaterByNameCity(name, city);
    if (dup) {
      cleanupNewUpload();
      return res.status(409).json({
        ok: false,
        error: "Theater with this name & city already exists",
        existingId: dup._id,
        data: dup,
      });
    }

    // Decide final image: upload first (Cloudinary) if req.file present
    let finalImage = bodyImageUrl || "";
    let finalPublicId = null;

    if (req.file) {
      const localPath = path.join(uploadDir, req.file.filename);
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await cloudinary.uploader.upload(localPath, {
          folder,
          use_filename: true,
          unique_filename: true,
          resource_type: "image",
        });
        // remove local temp
        safeUnlink(localPath);
        finalImage = result.secure_url;
        finalPublicId = result.public_id;
      } catch (e) {
        cleanupNewUpload();
        console.error("[Theaters] cloud upload failed:", e);
        return res.status(500).json({ ok: false, error: "Failed to upload image" });
      }
    }

    // normalize amenities
    const parsedAmenities = Array.isArray(amenities)
      ? amenities.map((a) => String(a).trim()).filter(Boolean)
      : typeof amenities === "string"
      ? amenities.split(",").map((a) => a.trim()).filter(Boolean)
      : [];

    const doc = {
      name: String(name).trim(),
      address: String(address).trim(),
      city: String(city).trim(),
      amenities: parsedAmenities,
      imageUrl: finalImage || "",
      posterUrl: finalImage || undefined,
      theaterImage: finalImage || undefined,
      posterPublicId: finalPublicId || undefined, // optional
      screens: Number(screens) || 1,
      nameLower: toLower(name),
      cityLower: toLower(city),
    };

    const theater = await Theater.create(doc);
    return res.status(201).json({ ok: true, data: theater });
  } catch (err) {
    if (req.file) cleanupNewUpload();
    if (err?.code === 11000) {
      const { name, city } = req.body;
      const existing = await findExistingTheaterByNameCity(name, city);
      return res.status(409).json({
        ok: false,
        error: "Theater with this name & city already exists",
        existingId: existing?._id,
        data: existing || null,
      });
    }
    console.error("[Theaters] POST / error:", err);
    return res.status(500).json({ ok: false, error: "Failed to create theater" });
  }
});

/**
 * PUT /api/theaters/:id
 * Update theater; if image replaced, delete old image (Cloudinary or local) and set new
 *
 * NOTE: consider adding requireAuth/requireAdmin here too.
 */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(400).json({ ok: false, error: "Invalid theater id" });
    }

    const existing = await Theater.findById(id);
    if (!existing) {
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
      return res.status(404).json({ ok: false, error: "Theater not found" });
    }

    const { name, address, city, amenities, imageUrl: bodyImageUrl } = req.body;

    // handle image: if new file -> cloud upload; if bodyImageUrl provided -> use it
    let imageUrl = existing.imageUrl || existing.posterUrl || existing.theaterImage || "";
    let newPublicId = existing.posterPublicId || null;
    let oldImageRef = null;

    if (req.file) {
      // upload new to cloud
      const localPath = path.join(uploadDir, req.file.filename);
      try {
        const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
        const result = await cloudinary.uploader.upload(localPath, {
          folder,
          use_filename: true,
          unique_filename: true,
          resource_type: "image",
        });
        safeUnlink(localPath);
        oldImageRef = existing.posterPublicId || existing.imageUrl || existing.posterUrl;
        imageUrl = result.secure_url;
        newPublicId = result.public_id;
      } catch (e) {
        safeUnlink(localPath);
        console.error("[Theaters] cloud upload failed (update):", e);
        return res.status(500).json({ ok: false, error: "Failed to upload image" });
      }
    } else if (typeof bodyImageUrl === "string" && bodyImageUrl && bodyImageUrl !== imageUrl) {
      // user provided a new URL (string) to replace current image
      oldImageRef = existing.posterPublicId || existing.imageUrl || existing.posterUrl;
      imageUrl = bodyImageUrl;
      // clear publicId if bodyImageUrl is not cloudinary (we won't attempt deletion by public id later)
      newPublicId = extractPublicId(bodyImageUrl) || undefined;
    }

    // normalize amenities
    const parsedAmenities =
      amenities === undefined
        ? existing.amenities
        : Array.isArray(amenities)
        ? amenities.map((a) => String(a).trim()).filter(Boolean)
        : typeof amenities === "string"
        ? amenities.split(",").map((a) => a.trim()).filter(Boolean)
        : existing.amenities;

    if (name !== undefined) {
      existing.name = String(name);
      existing.nameLower = toLower(name);
    }
    if (address !== undefined) existing.address = String(address);
    if (city !== undefined) {
      existing.city = String(city);
      existing.cityLower = toLower(city);
    }
    existing.amenities = parsedAmenities;

    if (imageUrl) {
      existing.imageUrl = imageUrl;
      existing.posterUrl = imageUrl;
      existing.theaterImage = imageUrl;
      existing.posterPublicId = newPublicId;
    }

    try {
      const saved = await existing.save();
      // If we replaced the image, attempt to delete the old one (cloud or local)
      if (oldImageRef && oldImageRef !== existing.imageUrl && oldImageRef !== existing.posterPublicId) {
        // delete if cloud or local
        await deleteCloudImageIfAny(oldImageRef);
      }
      return res.json({ ok: true, data: saved });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ ok: false, error: "Another theater with same name & city exists." });
      }
      throw err;
    }
  } catch (err) {
    console.error("[Theaters] PUT /:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to update theater" });
  }
});

/**
 * DELETE /api/theaters/:id
 * Remove theater + image + screens
 * NOTE: this will delete cloud image if stored as cloudinary url/public_id.
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ ok: false, error: "Invalid theater id" });

    const theater = await Theater.findById(id);
    if (!theater) return res.status(404).json({ ok: false, error: "Theater not found" });

    const oldImg = theater.posterPublicId || theater.imageUrl || theater.posterUrl || theater.theaterImage;
    if (oldImg) {
      await deleteCloudImageIfAny(oldImg);
    }

    await Screen.deleteMany({ theater: id });
    await theater.deleteOne();

    res.json({ ok: true });
  } catch (err) {
    console.error("[Theaters] DELETE /:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete theater" });
  }
});

/* ---------- Remaining GET routes (unchanged) ---------- */

router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const { q, city, name, page = 1, limit = 12 } = req.query;
    const filter = {};

    if (q) {
      filter.$or = [
        { name: new RegExp(q, "i") },
        { city: new RegExp(q, "i") },
        { address: new RegExp(q, "i") },
      ];
    }
    if (name) filter.nameLower = toLower(name);
    if (city && city !== "All") filter.cityLower = toLower(city);

    const safeLimit = Math.min(Number(limit) || 12, 1000);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [theaters, totalCount, cities] = await Promise.all([
      Theater.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(safeLimit).lean(),
      Theater.countDocuments(filter),
      Theater.distinct("city"),
    ]);

    const screenCounts = await Screen.aggregate([{ $group: { _id: "$theater", count: { $sum: 1 } } }]);
    const countMap = new Map(screenCounts.map((c) => [String(c._id), c.count]));

    const enriched = theaters.map((t) => ({ ...t, screensCount: countMap.get(String(t._id)) || 0 }));
    res.json({ ok: true, theaters: enriched, count: totalCount, cities, page: safePage, limit: safeLimit, hasMore: skip + enriched.length < totalCount });
  } catch (err) {
    console.error("[Theaters] GET / error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch theaters" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ ok: false, message: "Invalid theater id" });

    const theater = await Theater.findById(id).lean();
    if (!theater) return res.status(404).json({ ok: false, message: "Theater not found" });

    const screensCount = await Screen.countDocuments({ theater: new mongoose.Types.ObjectId(id) });
    res.json({ ok: true, data: { ...theater, screensCount } });
  } catch (err) {
    console.error("[Theaters] GET /:id error:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch theater" });
  }
});

router.get("/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ ok: false, error: "Invalid theater id" });

    const screens = await Screen.find({ theater: theaterId }).lean();
    res.json({ ok: true, data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /:theaterId/screens error:", err);
    res.status(500).json({ ok: false, error: "Failed to load screens" });
  }
});

router.post("/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    const { name = "Screen 1", rows = 10, columns = 15 } = req.body;

    if (!isId(theaterId)) return res.status(400).json({ ok: false, error: "Invalid theater id" });
    const theater = await Theater.findById(theaterId);
    if (!theater) return res.status(404).json({ ok: false, error: "Theater not found" });

    const screen = await Screen.create({ name, rows, columns, theater: theaterId });
    res.status(201).json({ ok: true, data: screen });
  } catch (err) {
    console.error("[Theaters] POST /:theaterId/screens error:", err);
    res.status(500).json({ ok: false, error: "Failed to create screen" });
  }
});

/* ----------------------- Multer-specific error handler -------------------- */
router.use((err, _req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, error: "File too large (max 3MB)" });
    if (err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ ok: false, error: err.message || "Invalid file" });
    return res.status(400).json({ ok: false, error: err.message || "File upload error" });
  }
  console.error("[Theaters router] unhandled error:", err);
  return res.status(500).json({ ok: false, error: "Server error" });
});

export default router;
