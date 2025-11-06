// backend/src/routes/screens.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import Screen from "../models/Screen.js";
import Theater from "../models/Theater.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  requireScopedTheatre,
  assertInScopeOrThrow,
} from "../middleware/scope.js";

const router = Router();

// For multipart/form-data without files (just fields). JSON also works via express.json earlier.
const parseFields = multer().none();
const isId = (id) => mongoose.isValidObjectId(id);

/* ----------------------------------------------------------------------------
 * ADMIN (scoped): /api/admin/theaters/:theaterId/screens[/:screenId]
 * SUPER/OWNER -> any theatre; THEATRE_ADMIN -> only their JWT.theatreId
 * ---------------------------------------------------------------------------- */

/**
 * GET all screens of a theatre (admin, scoped)
 */
router.get(
  "/admin/theaters/:theaterId/screens",
  requireAuth,
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId } = req.params;
      if (!isId(theaterId)) {
        return res.status(400).json({ ok: false, message: "Invalid theaterId" });
      }

      // Scope: theatre admin must only access own theatre
      assertInScopeOrThrow(theaterId, req);

      const screens = await Screen.find({ theater: theaterId })
        .sort({ name: 1 })
        .lean();

      return res.json({ ok: true, data: screens });
    } catch (err) {
      console.error("[Screens] GET list error:", err);
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/**
 * CREATE a screen in a theatre (admin, scoped)
 * Body: { name, rows, cols }
 */
router.post(
  "/admin/theaters/:theaterId/screens",
  requireAuth,
  requireAdmin,
  requireScopedTheatre,
  parseFields,
  async (req, res) => {
    try {
      const { theaterId } = req.params;
      if (!isId(theaterId)) {
        return res.status(400).json({ ok: false, message: "Invalid theaterId" });
      }

      // Scope
      assertInScopeOrThrow(theaterId, req);

      const theater = await Theater.findById(theaterId).select("_id").lean();
      if (!theater) return res.status(404).json({ ok: false, message: "Theater not found" });

      // Accept rows/cols; also tolerate legacy "columns" but store as cols
      const { name, rows, cols, columns } = req.body;
      const nRows = Number(rows);
      const nCols = Number(cols ?? columns);

      if (!name || !nRows || !nCols) {
        return res
          .status(400)
          .json({ ok: false, message: "name, rows, and cols are required" });
      }
      if (nRows <= 0 || nCols <= 0) {
        return res
          .status(400)
          .json({ ok: false, message: "rows and cols must be positive" });
      }

      const created = await Screen.create({
        name: String(name).trim(),
        rows: nRows,
        cols: nCols, // ✅ canonical
        theater: theaterId,
      });

      return res.status(201).json({ ok: true, data: created });
    } catch (err) {
      console.error("[Screens] POST create error:", err);
      if (err?.code === 11000) {
        return res
          .status(409)
          .json({ ok: false, message: "Screen name already exists for this theater" });
      }
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/**
 * GET one screen (admin, scoped)
 */
router.get(
  "/admin/theaters/:theaterId/screens/:screenId",
  requireAuth,
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) {
        return res.status(400).json({ ok: false, message: "Invalid ids" });
      }

      // Scope
      assertInScopeOrThrow(theaterId, req);

      const screen = await Screen.findOne({ _id: screenId, theater: theaterId }).lean();
      if (!screen) return res.status(404).json({ ok: false, message: "Screen not found" });

      return res.json({ ok: true, data: screen });
    } catch (err) {
      console.error("[Screens] GET one error:", err);
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/**
 * UPDATE a screen (admin, scoped)
 * Body (optional): { name, rows, cols }
 */
router.patch(
  "/admin/theaters/:theaterId/screens/:screenId",
  requireAuth,
  requireAdmin,
  requireScopedTheatre,
  parseFields,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) {
        return res.status(400).json({ ok: false, message: "Invalid ids" });
      }

      // Scope
      assertInScopeOrThrow(theaterId, req);

      const update = {};
      if (req.body.name !== undefined) update.name = String(req.body.name).trim();

      if (req.body.rows !== undefined) {
        const r = Number(req.body.rows);
        if (!r || r <= 0)
          return res.status(400).json({ ok: false, message: "rows must be a positive number" });
        update.rows = r;
      }

      // Accept cols or legacy columns, write to cols
      if (req.body.cols !== undefined || req.body.columns !== undefined) {
        const c = Number(req.body.cols ?? req.body.columns);
        if (!c || c <= 0)
          return res
            .status(400)
            .json({ ok: false, message: "cols must be a positive number" });
        update.cols = c;
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
      if (err?.code === 11000) {
        return res
          .status(409)
          .json({ ok: false, message: "Screen name already exists for this theater" });
      }
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/**
 * DELETE a screen (admin, scoped)
 */
router.delete(
  "/admin/theaters/:theaterId/screens/:screenId",
  requireAuth,
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) {
        return res.status(400).json({ ok: false, message: "Invalid ids" });
      }

      // Scope
      assertInScopeOrThrow(theaterId, req);

      const deleted = await Screen.findOneAndDelete({ _id: screenId, theater: theaterId });
      if (!deleted) return res.status(404).json({ ok: false, message: "Screen not found" });

      return res.json({ ok: true });
    } catch (err) {
      console.error("[Screens] DELETE error:", err);
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/* ----------------------------------------------------------------------------
 * PUBLIC ROUTES
 * ---------------------------------------------------------------------------- */

/**
 * Public: list screens for a theatre
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
 * Public: get a single screen by id
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
