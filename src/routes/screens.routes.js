// backend/src/routes/screens.routes.js — FULL UPDATED (patched)
// - requireAuth() usage (factory) already correct
// - Fixed requireAdmin usage: call the factory (requireAdmin())
// - Set router.routesPrefix to /api/screens for predictable auto-mount
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import Screen from "../models/Screen.js";
import Theater from "../models/Theater.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { requireScopedTheatre, assertInScopeOrThrow } from "../middleware/scope.js";

const router = Router();
/** ensure server auto-mounts under /api/screens (app or autoloader can use this) */
router.routesPrefix = "/api/screens";

const parseFields = multer().none();
const isId = (id) => mongoose.isValidObjectId(String(id || ""));

/* -------------------------
 * Small helpers
 * ------------------------- */
const badReq = (res, msg = "Invalid request") => res.status(400).json({ ok: false, message: msg });
const notFound = (res, msg = "Not found") => res.status(404).json({ ok: false, message: msg });

/* ----------------------------------------------------------------------------
 * ADMIN (scoped): /api/admin/theaters/:theaterId/screens[/:screenId]
 * ---------------------------------------------------------------------------- */

/** GET all screens of a theatre (admin, scoped) */
router.get(
  "/admin/theaters/:theaterId/screens",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId } = req.params;
      if (!isId(theaterId)) return badReq(res, "Invalid theaterId");

      assertInScopeOrThrow(theaterId, req);

      const screens = await Screen.find({
        $or: [{ theater: theaterId }, { theatreId: theaterId }],
      })
        .sort({ name: 1 })
        .lean();

      return res.json({ ok: true, data: screens });
    } catch (err) {
      console.error("[Screens] GET list error:", err);
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/** SUPER ADMIN: list ALL screens (no theaterId required) */
/** Now scoped: SUPER_ADMIN => all, THEATRE_ADMIN => only their theatre */
router.get("/admin/screens", requireAuth(), requireAdmin({ allowTheatreAdmin: true }), async (req, res) => {
  try {
    const role = String(req.user?.role || "").toUpperCase();
    const myTheatre = req.user?.theatreId || req.user?.theaterId || null;

    let filter = {};
    if (role === "THEATRE_ADMIN") {
      if (!myTheatre) return res.status(403).json({ ok: false, message: "No theatre set for this admin" });
      filter = { $or: [{ theater: myTheatre }, { theatreId: myTheatre }] };
    } else {
      // SUPER_ADMIN and ADMIN (if intended) see all
      filter = {};
    }

    const screens = await Screen.find(filter).sort({ name: 1 }).lean();
    return res.json({ ok: true, data: screens });
  } catch (err) {
    console.error("[Screens] GET ALL (admin) error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/** CREATE a screen in a theatre (admin, scoped) Body: { name, rows, cols } */
router.post(
  "/admin/theaters/:theaterId/screens",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  requireScopedTheatre,
  parseFields,
  async (req, res) => {
    try {
      const { theaterId } = req.params;
      if (!isId(theaterId)) return badReq(res, "Invalid theaterId");
      assertInScopeOrThrow(theaterId, req);

      const theater = await Theater.findById(theaterId).select("_id").lean();
      if (!theater) return notFound(res, "Theater not found");

      const { name, rows, cols, columns, format } = req.body || {};
      const nRows = Number(rows);
      const nCols = Number(cols ?? columns);

      if (!name || !nRows || !nCols) {
        return badReq(res, "name, rows, and cols are required");
      }
      if (!Number.isFinite(nRows) || !Number.isFinite(nCols) || nRows <= 0 || nCols <= 0) {
        return badReq(res, "rows and cols must be positive numbers");
      }

      const payload = {
        name: String(name).trim(),
        rows: nRows,
        cols: nCols,
        theater: theaterId,
      };

      if (format !== undefined) payload.format = String(format).trim();

      const created = await Screen.create(payload);

      // respond with the created document (lean copy)
      return res.status(201).json({ ok: true, data: created });
    } catch (err) {
      console.error("[Screens] POST create error:", err);
      if (err?.code === 11000) {
        return res.status(409).json({ ok: false, message: "Screen name already exists for this theater" });
      }
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/** GET one screen (admin, scoped) */
router.get(
  "/admin/theaters/:theaterId/screens/:screenId",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) return badReq(res, "Invalid ids");

      assertInScopeOrThrow(theaterId, req);

      const screen = await Screen.findOne({
        _id: screenId,
        $or: [{ theater: theaterId }, { theatreId: theaterId }],
      }).lean();

      if (!screen) return notFound(res, "Screen not found");

      return res.json({ ok: true, data: screen });
    } catch (err) {
      console.error("[Screens] GET one error:", err);
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/** UPDATE a screen (admin, scoped) Body (optional): { name, rows, cols, format } */
router.patch(
  "/admin/theaters/:theaterId/screens/:screenId",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  requireScopedTheatre,
  parseFields,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) return badReq(res, "Invalid ids");

      assertInScopeOrThrow(theaterId, req);

      const update = {};
      if (req.body.name !== undefined) update.name = String(req.body.name).trim();

      if (req.body.rows !== undefined) {
        const r = Number(req.body.rows);
        if (!Number.isFinite(r) || r <= 0) return badReq(res, "rows must be a positive number");
        update.rows = r;
      }

      // Accept cols or legacy columns, write to cols
      if (req.body.cols !== undefined || req.body.columns !== undefined) {
        const c = Number(req.body.cols ?? req.body.columns);
        if (!Number.isFinite(c) || c <= 0) return badReq(res, "cols must be a positive number");
        update.cols = c;
      }

      if (req.body.format !== undefined) update.format = String(req.body.format).trim();

      const updated = await Screen.findOneAndUpdate(
        { _id: screenId, $or: [{ theater: theaterId }, { theatreId: theaterId }] },
        { $set: update },
        { new: true, runValidators: true }
      ).lean();

      if (!updated) return notFound(res, "Screen not found");
      return res.json({ ok: true, data: updated });
    } catch (err) {
      console.error("[Screens] PATCH update error:", err);
      if (err?.code === 11000) {
        return res.status(409).json({ ok: false, message: "Screen name already exists for this theater" });
      }
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/** DELETE a screen (admin, scoped) */
router.delete(
  "/admin/theaters/:theaterId/screens/:screenId",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) return badReq(res, "Invalid ids");

      assertInScopeOrThrow(theaterId, req);

      const deleted = await Screen.findOneAndDelete({
        _id: screenId,
        $or: [{ theater: theaterId }, { theatreId: theaterId }],
      });

      if (!deleted) return notFound(res, "Screen not found");

      // NOTE: If you maintain showtimes or seat reservations tied to a screen,
      // consider cascading deletes or marking the screen as disabled instead.
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

/** Public: list screens for a theatre */
router.get("/theaters/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isId(theaterId)) return badReq(res, "Invalid theaterId");

    const screens = await Screen.find({
      $or: [{ theater: theaterId }, { theatreId: theaterId }],
    })
      .sort({ name: 1 })
      .lean();

    return res.json({ ok: true, data: screens });
  } catch (err) {
    console.error("[Screens] public list error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/** Public: get a single screen by id */
router.get("/screens/:screenId", async (req, res) => {
  try {
    const { screenId } = req.params;
    if (!isId(screenId)) return badReq(res, "Invalid screenId");

    const screen = await Screen.findById(screenId).lean();
    if (!screen) return notFound(res, "Screen not found");

    return res.json({ ok: true, data: screen });
  } catch (err) {
    console.error("[Screens] GET public one error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/* ----------------------------------------------------------------------------
 * FRONTEND COMPATIBILITY ALIAS (expected by AdminShowtimes page)
 * ---------------------------------------------------------------------------- */

/** AdminShowtimes expects: GET /api/screens/by-theatre/:id -> raw array */
router.get("/screens/by-theatre/:id", requireAuth(), async (req, res) => {
  try {
    const id = req.params.id;
    if (!isId(id)) return res.status(400).json({ error: "Invalid theatre id" });

    const role = String(req.user?.role || "").toUpperCase();
    const myTheatre = req.user?.theatreId || req.user?.theaterId || null;

    // SUPER_ADMIN -> allowed any id
    if (role === "THEATRE_ADMIN") {
      // theatre admin only allowed their own theatre
      if (!myTheatre || String(myTheatre) !== String(id)) {
        return res.status(403).json({ error: "Forbidden — not your theatre" });
      }
    }

    const list = await Screen.find({
      $or: [{ theater: id }, { theatreId: id }],
    })
      .select("_id name rows cols seats theater theatreId")
      .sort({ name: 1 })
      .lean();

    // return a raw array (not wrapped), matching frontend expectations
    return res.json(list || []);
  } catch (err) {
    console.error("[Screens] alias /screens/by-theatre/:id error:", err);
    return res.status(500).json({ error: "Failed to load screens" });
  }
});

/* --------------------------------------------------------------------------
 * Seat-label helper endpoints (useful for showtimes / seat map UI)
 * -------------------------------------------------------------------------- */

const buildSeatLabels = (rows, cols) => {
  const labels = [];
  const toRowLabel = (n) => {
    let label = "";
    let x = n;
    while (x > 0) {
      x -= 1;
      label = String.fromCharCode(65 + (x % 26)) + label;
      x = Math.floor(x / 26);
    }
    return label;
  };

  for (let r = 1; r <= rows; r++) {
    const rowLabel = toRowLabel(r);
    for (let c = 1; c <= cols; c++) {
      labels.push(`${rowLabel}${c}`);
    }
  }
  return labels;
};

router.get(
  "/admin/theaters/:theaterId/screens/:screenId/seats",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  requireScopedTheatre,
  async (req, res) => {
    try {
      const { theaterId, screenId } = req.params;
      if (!isId(theaterId) || !isId(screenId)) return badReq(res, "Invalid ids");

      assertInScopeOrThrow(theaterId, req);

      const screen = await Screen.findOne({
        _id: screenId,
        $or: [{ theater: theaterId }, { theatreId: theaterId }],
      }).lean();

      if (!screen) return notFound(res, "Screen not found");

      const rows = Number(screen.rows) || 0;
      const cols = Number(screen.cols) || 0;
      const seats = buildSeatLabels(rows, cols);

      return res.json({ ok: true, data: seats, rows, cols });
    } catch (err) {
      console.error("[Screens] GET seats (admin) error:", err);
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

router.get("/screens/:screenId/seats", async (req, res) => {
  try {
    const { screenId } = req.params;
    if (!isId(screenId)) return badReq(res, "Invalid screenId");

    const screen = await Screen.findById(screenId).lean();
    if (!screen) return notFound(res, "Screen not found");

    const rows = Number(screen.rows) || 0;
    const cols = Number(screen.cols) || 0;
    const seats = buildSeatLabels(rows, cols);

    return res.json({ ok: true, data: seats, rows, cols });
  } catch (err) {
    console.error("[Screens] GET seats (public) error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;
