import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import Screen from "../models/Screen.js";
import Theater from "../models/Theater.js";

const router = Router();
const parseFields = multer().none();
const isId = (id) => mongoose.isValidObjectId(id);

/* ------------------------------ Optional auth ------------------------------ */
// Add these only if your app uses JWT auth (like your bookings.routes)
function requireAuth(req, res, next) {
  if (!req.user || !req.user._id) return res.status(401).json({ message: "Unauthenticated" });
  next();
}
function requireAdmin(req, res, next) {
  const role = (req.user?.role || "").toUpperCase();
  if (role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
  next();
}

/* ------------------------------ ADMIN ROUTES ------------------------------ */

/**
 * GET /api/admin/theaters/:theaterId/screens
 * List all screens for a specific theater
 */
router.get("/admin/theaters/:theaterId/screens", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ message: "Invalid theaterId" });

    const screens = await Screen.find({ theater: theaterId }).sort({ name: 1 }).lean();
    return res.json(screens);
  } catch (err) {
    console.error("[Screens] GET list error:", err);
    return res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/admin/theaters/:theaterId/screens
 * Create a new screen under a theater
 */
router.post("/admin/theaters/:theaterId/screens", requireAuth, requireAdmin, parseFields, async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ message: "Invalid theaterId" });

    const theater = await Theater.findById(theaterId);
    if (!theater) return res.status(404).json({ message: "Theater not found" });

    const { name, rows, cols, columns } = req.body;
    const parsedRows = Number(rows);
    const parsedCols = Number(cols ?? columns);

    if (!name || !parsedRows || !parsedCols)
      return res.status(400).json({ message: "name, rows, and cols are required" });

    const created = await Screen.create({
      name: String(name).trim(),
      rows: parsedRows,
      cols: parsedCols,
      theater: theaterId,
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error("[Screens] POST create error:", err);
    if (err.code === 11000)
      return res.status(409).json({ message: "Screen name already exists for this theater" });
    return res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/admin/theaters/:theaterId/screens/:screenId
 * Get single screen details
 */
router.get("/admin/theaters/:theaterId/screens/:screenId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId, screenId } = req.params;
    if (!isId(theaterId) || !isId(screenId))
      return res.status(400).json({ message: "Invalid ids" });

    const screen = await Screen.findOne({ _id: screenId, theater: theaterId }).lean();
    if (!screen) return res.status(404).json({ message: "Screen not found" });

    return res.json(screen);
  } catch (err) {
    console.error("[Screens] GET one error:", err);
    return res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/admin/theaters/:theaterId/screens/:screenId
 * Update a screen (used by your AdminScreens.jsx)
 */
router.patch("/admin/theaters/:theaterId/screens/:screenId", requireAuth, requireAdmin, parseFields, async (req, res) => {
  try {
    const { theaterId, screenId } = req.params;
    if (!isId(theaterId) || !isId(screenId))
      return res.status(400).json({ message: "Invalid ids" });

    const update = {};
    if (req.body.name) update.name = String(req.body.name).trim();
    if (req.body.rows) update.rows = Number(req.body.rows);
    if (req.body.cols || req.body.columns)
      update.cols = Number(req.body.cols ?? req.body.columns);

    const updated = await Screen.findOneAndUpdate(
      { _id: screenId, theater: theaterId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ message: "Screen not found" });
    return res.json(updated);
  } catch (err) {
    console.error("[Screens] PATCH update error:", err);
    return res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /api/admin/theaters/:theaterId/screens/:screenId
 * Delete a screen from a theater
 */
router.delete("/admin/theaters/:theaterId/screens/:screenId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId, screenId } = req.params;
    if (!isId(theaterId) || !isId(screenId))
      return res.status(400).json({ message: "Invalid ids" });

    const deleted = await Screen.findOneAndDelete({ _id: screenId, theater: theaterId });
    if (!deleted) return res.status(404).json({ message: "Screen not found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[Screens] DELETE error:", err);
    return res.status(500).json({ message: err.message });
  }
});

/* ------------------------------ PUBLIC ROUTES ------------------------------ */

/**
 * GET /api/theaters/:theaterId/screens
 * Public list of screens
 */
router.get("/theaters/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ message: "Invalid theaterId" });

    const screens = await Screen.find({ theater: theaterId }).sort({ name: 1 }).lean();
    return res.json(screens);
  } catch (err) {
    console.error("[Screens] public list error:", err);
    return res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/screens/:screenId
 * Public single screen details
 */
router.get("/screens/:screenId", async (req, res) => {
  try {
    const { screenId } = req.params;
    if (!isId(screenId)) return res.status(400).json({ message: "Invalid screenId" });

    const screen = await Screen.findById(screenId).lean();
    if (!screen) return res.status(404).json({ message: "Screen not found" });

    return res.json(screen);
  } catch (err) {
    console.error("[Screens] GET public one error:", err);
    return res.status(500).json({ message: err.message });
  }
});

export default router;
