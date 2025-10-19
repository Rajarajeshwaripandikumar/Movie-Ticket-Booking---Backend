// backend/src/routes/theaters.routes.js
import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import mongoose from "mongoose";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               Multer setup                                 */
/* -------------------------------------------------------------------------- */
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

// return MulterError for invalid file -> consistent handling later
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

// Safe unlink that refuses to unlink outside uploadDir
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

// Try to find existing by lowers; if not present in DB, fallback to i-regex
async function findExistingTheaterByNameCity(name, city) {
  const nameLower = toLower(name);
  const cityLower = toLower(city);

  let existing = await Theater.findOne({ nameLower, cityLower }).lean();
  if (existing) return existing;

  // Fallback for legacy docs without lower fields
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
 * Create new theater (accepts JSON or multipart form)
 * - Idempotent: pre-check existing by (name, city) case-insensitively
 * - If duplicate → 409 with existing doc
 */
router.post("/", upload.single("image"), async (req, res) => {
  // Build image URL from either multipart `image` or JSON `imageUrl`
  const uploadedImageUrl = req.file ? `/uploads/${req.file.filename}` : "";
  const cleanupNewUpload = () => {
    if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
  };

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

    // choose final image
    const finalImage = uploadedImageUrl || String(bodyImageUrl || "");

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
      screens: Number(screens) || 1,
      // In case your model's pre('save') sets these, it's fine; otherwise set explicitly:
      nameLower: toLower(name),
      cityLower: toLower(city),
    };

    const theater = await Theater.create(doc);
    return res.status(201).json({ ok: true, data: theater });
  } catch (err) {
    // Duplicate key from DB (race condition) → map to 409 and return existing
    if (err?.code === 11000) {
      const { name, city } = req.body;
      const existing = await findExistingTheaterByNameCity(name, city);
      if (req.file) cleanupNewUpload();
      return res.status(409).json({
        ok: false,
        error: "Theater with this name & city already exists",
        existingId: existing?._id,
        data: existing || null,
      });
    }
    console.error("[Theaters] POST / error:", err);
    if (req.file) cleanupNewUpload();
    return res.status(500).json({ ok: false, error: "Failed to create theater" });
  }
});

/**
 * PUT /api/theaters/:id
 * Update theater; deletes old image if replaced
 * - pre('save') on model may keep lower fields in sync; we also sync explicitly
 */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ ok: false, error: "Invalid theater id" });

    const existing = await Theater.findById(id);
    if (!existing) return res.status(404).json({ ok: false, error: "Theater not found" });

    const { name, address, city, amenities, imageUrl: bodyImageUrl } = req.body;

    // handle image
    let imageUrl = existing.imageUrl || existing.posterUrl || existing.theaterImage || "";
    if (req.file) {
      if (imageUrl) safeUnlink(imageUrl);
      imageUrl = `/uploads/${req.file.filename}`;
    } else if (typeof bodyImageUrl === "string" && bodyImageUrl && bodyImageUrl !== imageUrl) {
      // allow replacing via JSON string
      imageUrl = bodyImageUrl;
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
    }

    try {
      const saved = await existing.save(); // pre('save') will also run if defined
      return res.json({ ok: true, data: saved });
    } catch (err) {
      // If user tries to rename to a duplicate name+city
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
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ ok: false, error: "Invalid theater id" });

    const theater = await Theater.findById(id);
    if (!theater) return res.status(404).json({ ok: false, error: "Theater not found" });

    const oldImg = theater.imageUrl || theater.posterUrl || theater.theaterImage;
    if (oldImg) safeUnlink(oldImg);

    await Screen.deleteMany({ theater: id });
    await theater.deleteOne();

    res.json({ ok: true });
  } catch (err) {
    console.error("[Theaters] DELETE /:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete theater" });
  }
});

/**
 * GET /api/theaters
 * Paginated, newest-first list with city list and screen counts
 * - Uses lower-case fields for exact filters
 */
router.get("/", async (req, res) => {
  try {
    // no-cache headers
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

    // Exact filters (normalized)
    if (name) filter.nameLower = toLower(name);
    if (city && city !== "All") filter.cityLower = toLower(city);

    const safeLimit = Math.min(Number(limit) || 12, 1000);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [theaters, totalCount, cities] = await Promise.all([
      Theater.find(filter)
        .sort({ updatedAt: -1, _id: -1 }) // newest first
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Theater.countDocuments(filter),
      Theater.distinct("city"),
    ]);

    // attach screen counts
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
    res.status(500).json({ ok: false, message: "Failed to fetch theaters" });
  }
});

/**
 * GET /api/theaters/:id
 * Single theater + screen count
 */
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

/**
 * GET /api/theaters/:theaterId/screens
 * List screens for one theater
 */
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

/**
 * POST /api/theaters/:theaterId/screens
 * Quick add screen for a theater
 */
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
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: "File too large (max 3MB)" });
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ ok: false, error: err.message || "Invalid file" });
    }
    return res.status(400).json({ ok: false, error: err.message || "File upload error" });
  }
  // Generic fallback
  console.error("[Theaters router] unhandled error:", err);
  return res.status(500).json({ ok: false, error: "Server error" });
});

export default router;
