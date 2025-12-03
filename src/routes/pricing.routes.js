// backend/src/routes/pricing.routes.js
import express from "express";
import mongoose from "mongoose";
import Pricing from "../models/Pricing.js";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = express.Router();
const isId = (id) => mongoose.isValidObjectId(id);

// normalize to Title Case: "REGULAR" -> "Regular"
const normSeatType = (s) => {
  const raw = String(s || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "regular") return "Regular";
  if (lower === "premium") return "Premium";
  if (lower === "vip" || lower === "v.i.p") return "VIP";
  // fallback: capitalize first letter
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
};

// Optional: theatre-scoped admin (THEATRE_ADMIN only sees/edits own theatre)
function isTheatreScopedRole(req) {
  const role = String(req.user?.role || "").toUpperCase();
  return role.includes("THEATRE") || role.includes("THEATER") || role.includes("THEATRE_ADMIN") || role.includes("THEATER_ADMIN");
}
function assertScopeOrThrow(theaterId, req) {
  if (!isTheatreScopedRole(req)) return;
  const jwtTheatreId = String(req.user?.theatreId || "");
  if (!jwtTheatreId || jwtTheatreId !== String(theaterId)) {
    const err = new Error("Forbidden: out-of-scope theatre");
    err.status = 403;
    throw err;
  }
}

function ok(data = {}) { return { ok: true, ...data }; }
function bad(status, message) { return { status, message }; }

/* -------------------------------------------------------------------------- */
/* CREATE/UPSERT (single)                                                     */
/* -------------------------------------------------------------------------- */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId, screenId, seatType, price, currency } = req.body;

    if (!isId(theaterId) || !isId(screenId)) {
      return res.status(400).json(bad(400, "Invalid theaterId or screenId"));
    }
    if (seatType == null || price == null) {
      return res.status(400).json(bad(400, "seatType and price are required"));
    }
    const seat = normSeatType(seatType);
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json(bad(400, "price must be a non-negative number"));
    }

    // Scope check (if theatre-admin)
    assertScopeOrThrow(theaterId, req);

    // Existence + relationship check
    const [theater, screen] = await Promise.all([
      Theater.findById(theaterId).select("_id").lean(),
      Screen.findById(screenId).select("_id theater").lean(),
    ]);
    if (!theater) return res.status(404).json(bad(404, "Theater not found"));
    if (!screen) return res.status(404).json(bad(404, "Screen not found"));
    if (String(screen.theater) !== String(theaterId)) {
      return res.status(400).json(bad(400, "screenId does not belong to theaterId"));
    }

    const updated = await Pricing.findOneAndUpdate(
      { theaterId, screenId, seatType: seat },
      { price: amount, currency: currency || "INR", updatedAt: new Date() },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json(ok({ data: updated }));
  } catch (err) {
    console.error("pricing.post:", err);
    const code = err.status || 500;
    return res.status(code).json({ message: err.message || "Failed to upsert pricing" });
  }
});

/* -------------------------------------------------------------------------- */
/* BULK UPSERT                                                                 */
/* -------------------------------------------------------------------------- */
router.post("/bulk", requireAuth, requireAdmin, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json(bad(400, "items array is required"));

    if (isTheatreScopedRole(req)) {
      const allowed = String(req.user?.theatreId || "");
      for (const it of items) {
        if (String(it.theaterId) !== allowed) {
          return res.status(403).json(bad(403, "Contains out-of-scope theatre entries"));
        }
      }
    }

    const byScreen = new Map();
    for (const it of items) {
      const { theaterId, screenId, seatType, price } = it || {};
      if (!isId(theaterId) || !isId(screenId)) {
        return res.status(400).json(bad(400, "Invalid theaterId or screenId in items"));
      }
      if (seatType == null || price == null) {
        return res.status(400).json(bad(400, "Each item needs seatType and price"));
      }
      const amount = Number(price);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json(bad(400, "price must be non-negative in items"));
      }
      byScreen.set(String(screenId), theaterId);
    }

    const screens = await Screen.find({ _id: { $in: [...byScreen.keys()] } })
      .select("_id theater")
      .lean();
    const screenMap = new Map(screens.map((s) => [String(s._id), String(s.theater)]));

    for (const [screenId, theaterId] of byScreen.entries()) {
      const th = screenMap.get(String(screenId));
      if (!th) return res.status(400).json(bad(400, `Screen not found: ${screenId}`));
      if (String(th) !== String(theaterId)) {
        return res.status(400).json(bad(400, `Screen ${screenId} does not belong to theater ${theaterId}`));
      }
    }

    const ops = items.map((it) => ({
      updateOne: {
        filter: {
          theaterId: it.theaterId,
          screenId: it.screenId,
          seatType: normSeatType(it.seatType),
        },
        update: {
          $set: {
            price: Number(it.price),
            currency: it.currency || "INR",
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

    const result = await Pricing.bulkWrite(ops, { ordered: false });
    return res.json(ok({ result }));
  } catch (err) {
    console.error("pricing.bulk:", err);
    return res.status(500).json({ message: err.message || "Bulk upsert failed" });
  }
});

/* -------------------------------------------------------------------------- */
/* LIST (admin/theatre-admin scoped)                                          */
/* -------------------------------------------------------------------------- */
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId, screenId } = req.query;
    const q = {};

    if (theaterId) {
      if (!isId(theaterId)) return res.status(400).json(bad(400, "Invalid theaterId"));
      assertScopeOrThrow(theaterId, req);
      q.theaterId = theaterId;
    } else if (isTheatreScopedRole(req)) {
      const scopedId = req.user?.theatreId;
      if (!scopedId) return res.json(ok({ data: [] }));
      q.theaterId = scopedId;
    }

    if (screenId) {
      if (!isId(screenId)) return res.status(400).json(bad(400, "Invalid screenId"));
      q.screenId = screenId;
    }

    const list = await Pricing.find(q)
      .populate("theaterId", "name city")
      .populate("screenId", "name rows cols")
      .lean();

    return res.json(ok({ data: list }));
  } catch (err) {
    console.error("pricing.get:", err);
    return res.status(500).json({ message: err.message || "Failed to load pricing" });
  }
});

/* -------------------------------------------------------------------------- */
/* MATRIX VIEW                                                                */
/* -------------------------------------------------------------------------- */
router.get("/matrix", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theaterId } = req.query;
    if (!isId(theaterId)) return res.status(400).json(bad(400, "Invalid theaterId"));

    assertScopeOrThrow(theaterId, req);

    const rows = await Pricing.find({ theaterId }).lean();
    const out = {};
    for (const r of rows) {
      const sid = String(r.screenId);
      if (!out[sid]) out[sid] = {};
      out[sid][normSeatType(r.seatType)] = { price: r.price, currency: r.currency || "INR" };
    }
    return res.json(ok({ data: out }));
  } catch (err) {
    console.error("pricing.matrix:", err);
    return res.status(500).json({ message: err.message || "Failed to load matrix" });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE                                                                     */
/* -------------------------------------------------------------------------- */
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json(bad(400, "Invalid id"));

    const doc = await Pricing.findById(id).select("_id theaterId").lean();
    if (!doc) return res.status(404).json(bad(404, "Not found"));

    assertScopeOrThrow(doc.theaterId, req);

    await Pricing.findByIdAndDelete(id);
    return res.json(ok({ id }));
  } catch (err) {
    console.error("pricing.delete:", err);
    const code = err.status || 500;
    return res.status(code).json({ message: err.message || "Failed to delete" });
  }
});

export default router;
