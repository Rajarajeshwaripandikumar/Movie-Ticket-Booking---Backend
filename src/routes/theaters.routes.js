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

const fileFilter = (_, file, cb) =>
  ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error("Only image files are allowed"));

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */
const isId = (id) => mongoose.isValidObjectId(id);
const safeUnlink = (rel) => {
  try {
    if (!rel) return;
    const abs = rel.startsWith("/uploads/") ? path.join(process.cwd(), rel) : rel;
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {}
};

/* -------------------------------------------------------------------------- */
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/theaters
 * Create new theater (accepts JSON or multipart form)
 * - Enforces case-insensitive uniqueness on (name, city) via model index
 * - On 409, returns existing document and cleans up newly uploaded file
 */
router.post("/", upload.single("image"), async (req, res) => {
  const cleanupNewUpload = () => {
    if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
  };

  try {
    const { name, address = "", city, amenities = "", screens = 1 } = req.body;
    if (!name || !city) {
      cleanupNewUpload();
      return res.status(400).json({ error: "Name and city are required" });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";

    // normalize amenities
    const parsedAmenities = Array.isArray(amenities)
      ? amenities.map((a) => String(a).trim()).filter(Boolean)
      : typeof amenities === "string"
      ? amenities.split(",").map((a) => a.trim()).filter(Boolean)
      : [];

    // Attempt create (unique index will catch conflicts)
    const theater = await Theater.create({
      name: String(name).trim(),
      address: String(address).trim(),
      city: String(city).trim(),
      amenities: parsedAmenities,
      imageUrl,
      posterUrl: imageUrl || undefined,
      theaterImage: imageUrl || undefined,
      screens: Number(screens) || 1,
    });

    return res.status(201).json({ ok: true, data: theater });
  } catch (err) {
    // Duplicate key => return existing doc so UI can prefill
    if (err?.code === 11000) {
      // remove the newly uploaded file to avoid orphan files
      if (req.file) safeUnlink(`/uploads/${req.file.filename}`);

      const nameLower = (req.body?.name || "").trim().toLowerCase();
      const cityLower = (req.body?.city || "").trim().toLowerCase();
      const existing = await Theater.findOne({ nameLower, cityLower }).lean();

      return res.status(409).json({
        error: "Theater with this name & city already exists",
        existingId: existing?._id,
        data: existing || null,
      });
    }
    console.error("[Theaters] POST / error:", err);
    if (req.file) safeUnlink(`/uploads/${req.file.filename}`);
    return res.status(500).json({ error: "Failed to create theater" });
  }
});

/**
 * PUT /api/theaters/:id
 * Update theater; deletes old image if replaced
 * - pre('save') on model will keep lower fields in sync
 */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid theater id" });

    const existing = await Theater.findById(id);
    if (!existing) return res.status(404).json({ error: "Theater not found" });

    const { name, address, city, amenities } = req.body;

    // handle image
    let imageUrl = existing.imageUrl || existing.posterUrl || existing.theaterImage || "";
    if (req.file) {
      if (imageUrl) safeUnlink(imageUrl);
      imageUrl = `/uploads/${req.file.filename}`;
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

    if (name !== undefined) existing.name = String(name);
    if (address !== undefined) existing.address = String(address);
    if (city !== undefined) existing.city = String(city);
    existing.amenities = parsedAmenities;

    if (imageUrl) {
      existing.imageUrl = imageUrl;
      existing.posterUrl = imageUrl;
      existing.theaterImage = imageUrl;
    }

    const saved = await existing.save(); // pre('save') updates lowers
    return res.json({ ok: true, data: saved });
  } catch (err) {
    // If user tries to rename to a duplicate name+city
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Another theater with same name & city exists." });
    }
    console.error("[Theaters] PUT /:id error:", err);
    return res.status(500).json({ error: "Failed to update theater" });
  }
});

/**
 * DELETE /api/theaters/:id
 * Remove theater + image + screens
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ error: "Invalid theater id" });

    const theater = await Theater.findById(id);
    if (!theater) return res.status(404).json({ error: "Theater not found" });

    const oldImg = theater.imageUrl || theater.posterUrl || theater.theaterImage;
    if (oldImg) safeUnlink(oldImg);

    await Screen.deleteMany({ theater: id });
    await theater.deleteOne();

    res.json({ ok: true });
  } catch (err) {
    console.error("[Theaters] DELETE /:id error:", err);
    res.status(500).json({ error: "Failed to delete theater" });
  }
});

/**
 * GET /api/theaters
 * Paginated, newest-first list with city list and screen counts
 * - Adds exact filters by name & city (case-insensitive) for duplicate pre-checks
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

    if (city && city !== "All") filter.city = city;

    // Exact match filters (used by frontend pre-check)
    if (name) filter.nameLower = String(name).trim().toLowerCase();
    if (city && city !== "All") {
      filter.cityLower = String(city).trim().toLowerCase();
    }

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
    if (!isId(id)) return res.status(400).json({ message: "Invalid theater id" });

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
 * List screens for one theater
 */
router.get("/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ error: "Invalid theater id" });

    const screens = await Screen.find({ theater: theaterId }).lean();
    res.json({ data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /:theaterId/screens error:", err);
    res.status(500).json({ error: "Failed to load screens" });
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

    if (!isId(theaterId)) return res.status(400).json({ error: "Invalid theater id" });

    const theater = await Theater.findById(theaterId);
    if (!theater) return res.status(404).json({ error: "Theater not found" });

    const screen = await Screen.create({ name, rows, columns, theater: theaterId });
    res.status(201).json({ ok: true, data: screen });
  } catch (err) {
    console.error("[Theaters] POST /:theaterId/screens error:", err);
    res.status(500).json({ error: "Failed to create screen" });
  }
});

export default router;
