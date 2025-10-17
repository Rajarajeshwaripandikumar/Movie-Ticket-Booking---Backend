// backend/src/routes/screens.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import Screen from "../models/Screen.js";
import Theater from "../models/Theater.js";

const router = Router();

// For multipart form posts without files (JSON still works via express.json earlier)
const parseFields = multer().none();
const isId = (id) => mongoose.isValidObjectId(id);

/* ------------------------------ Optional auth ------------------------------ */
// If you're already gating /api/admin with requireAuth/requireAdmin in app.js, you can remove these.
// Keeping them here is fine too (belt + suspenders).
function requireAuth(req, res, next) {
  if (!req.user || !req.user._id) return res.status(401).json({ ok: false, message: "Unauthenticated" });
  next();
}
function requireAdmin(req, res, next) {
  const role = (req.user?.role || "").toUpperCase();
  if (role !== "ADMIN") return res.status(403).json({ ok: false, message: "Admin only" });
  next();
}

/* ------------------------------ ADMIN ROUTES ------------------------------ */

/**
 * GET /api/admin/theaters/:theaterId/screens
 */
router.get("/admin/theaters/:theaterId/screens", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ ok: false, message: "Invalid theaterId" });

    const screens = await Screen.find({ theater: theaterId }).sort({ name: 1 }).lean();
    return res.json({ ok: true, data: screens });
  } catch (err) {
    console.error("[Screens] GET list error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * POST /api/admin/theaters/:theaterId/screens
 */
router.post("/admin/theaters/:theaterId/screens", requireAuth, requireAdmin, parseFields, async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ ok: false, message: "Invalid theaterId" });

    const theater = await Theater.findById(theaterId);
    if (!theater) return res.status(404).json({ ok: false, message: "Theater not found" });

    const { name, rows, cols, columns } = req.body;
    const parsedRows = Number(rows);
    const parsedColumns = Number(cols ?? columns);

    if (!name || !parsedRows || !parsedColumns) {
      return res.status(400).json({ ok: false, message: "name, rows, and columns are required" });
    }
    if (parsedRows <= 0 || parsedColumns <= 0) {
      return res.status(400).json({ ok: false, message: "rows and columns must be positive" });
    }

    const created = await Screen.create({
      name: String(name).trim(),
      rows: parsedRows,
      columns: parsedColumns, // ✅ standardized
      theater: theaterId,
    });

    return res.status(201).json({ ok: true, data: created });
  } catch (err) {
    console.error("[Screens] POST create error:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ ok: false, message: "Screen name already exists for this theater" });
    }
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * GET /api/admin/theaters/:theaterId/screens/:screenId
 */
router.get("/admin/theaters/:theaterId/screens/:screenId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId, screenId } = req.params;
    if (!isId(theaterId) || !isId(screenId)) {
      return res.status(400).json({ ok: false, message: "Invalid ids" });
    }

    const screen = await Screen.findOne({ _id: screenId, theater: theaterId }).lean();
    if (!screen) return res.status(404).json({ ok: false, message: "Screen not found" });

    return res.json({ ok: true, data: screen });
  } catch (err) {
    console.error("[Screens] GET one error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * PATCH /api/admin/theaters/:theaterId/screens/:screenId
 */
router.patch("/admin/theaters/:theaterId/screens/:screenId", requireAuth, requireAdmin, parseFields, async (req, res) => {
  try {
    const { theaterId, screenId } = req.params;
    if (!isId(theaterId) || !isId(screenId)) {
      return res.status(400).json({ ok: false, message: "Invalid ids" });
    }

    const update = {};
    if (req.body.name !== undefined) update.name = String(req.body.name).trim();
    if (req.body.rows !== undefined) {
      const n = Number(req.body.rows);
      if (!n || n <= 0) return res.status(400).json({ ok: false, message: "rows must be a positive number" });
      update.rows = n;
    }
    if (req.body.cols !== undefined || req.body.columns !== undefined) {
      const c = Number(req.body.cols ?? req.body.columns);
      if (!c || c <= 0) return res.status(400).json({ ok: false, message: "columns must be a positive number" });
      update.columns = c; // ✅ standardized
    }

    const updated = await Screen.findOneAndUpdate(
      { _id: screenId, theater: theaterId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ ok: false, message: "Screen not found" });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[Screens] PATCH update error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * DELETE /api/admin/theaters/:theaterId/screens/:screenId
 */
router.delete("/admin/theaters/:theaterId/screens/:screenId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId, screenId } = req.params;
    if (!isId(theaterId) || !isId(screenId)) {
      return res.status(400).json({ ok: false, message: "Invalid ids" });
    }

    const deleted = await Screen.findOneAndDelete({ _id: screenId, theater: theaterId });
    if (!deleted) return res.status(404).json({ ok: false, message: "Screen not found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[Screens] DELETE error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/* ------------------------------ PUBLIC ROUTES ------------------------------ */

/**
 * GET /api/theaters/:theaterId/screens
 */
router.get("/theaters/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return res.status(400).json({ ok: false, message: "Invalid theaterId" });

    const screens = await Screen.find({ theater: theaterId }).sort({ name: 1 }).lean();
    return res.json({ ok: true, data: screens });
  } catch (err) {
    console.error("[Screens] public list error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * GET /api/screens/:screenId
 */
router.get("/screens/:screenId", async (req, res) => {
  try {
    const { screenId } = req.params;
    if (!isId(screenId)) return res.status(400).json({ ok: false, message: "Invalid screenId" });

    const screen = await Screen.findById(screenId).lean();
    if (!screen) return res.status(404).json({ ok: false, message: "Screen not found" });

    return res.json({ ok: true, data: screen });
  } catch (err) {
    console.error("[Screens] GET public one error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;
