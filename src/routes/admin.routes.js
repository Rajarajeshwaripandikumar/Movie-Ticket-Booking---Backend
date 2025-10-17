// backend/src/routes/admin.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";

import { requireAuth, requireAdmin } from "../middleware/auth.js";

import User from "../models/User.js";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import Showtime from "../models/Showtime.js";
import Booking from "../models/Booking.js";

// IMPORTANT: reuse the movies router so admin can call /api/admin/movies/...
import moviesRouter from "./movies.routes.js";

const router = Router();

/**
 * NOTE:
 * app.js mounts this file under /api/admin with:
 *   app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);
 *
 * That means every route here is already behind auth+admin when mounted.
 * We still keep requireAdmin on sensitive endpoints for clarity/defense-in-depth.
 */

/* ----------------------------- DEBUG / INFO ------------------------------- */
// debug which user (route kept for convenience)
router.get("/debug/me", requireAuth, (req, res) => res.json({ user: req.user }));

/* --------------------------- Mount admin routers -------------------------- */
// Mount movies routes under /api/admin/movies
// This reuses your existing movies router (which contains POST/PUT/DELETE/multer logic).
// Because app.js wraps /api/admin with requireAuth+requireAdmin, these routes are protected.
router.use("/movies", moviesRouter);

/* ----------------------------- PROFILE / AUTH ----------------------------- */
router.get("/me", requireAdmin, async (req, res) => {
  try {
    const id = req.user?._id || req.user?.sub;
    if (!id) return res.status(401).json({ message: "Unauthenticated" });

    const doc = await User.findById(id).lean();
    if (!doc) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, avatarUrl, phone, city, createdAt, updatedAt } = doc;
    res.json({ id: _id, email, role, name, avatarUrl, phone, city, createdAt, updatedAt });
  } catch (e) {
    console.error("[Admin] /me error:", e);
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});

router.put("/profile", requireAdmin, async (req, res) => {
  try {
    const id = req.user?._id || req.user?.sub;
    if (!id) return res.status(401).json({ message: "Unauthenticated" });

    const allowed = ["name", "avatarUrl", "phone", "city"];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    const updated = await User.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, avatarUrl, phone, city, createdAt, updatedAt } = updated;
    res.json({ id: _id, email, role, name, avatarUrl, phone, city, createdAt, updatedAt });
  } catch (e) {
    console.error("[Admin] update profile error:", e);
    res.status(500).json({ message: "Failed to update profile", error: e.message });
  }
});

/* ------------------------- CHANGE PASSWORD ------------------------- */
router.post("/change-password", requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ ok: false, message: "Invalid input" });
    }

    const id = req.user?._id || req.user?.sub;
    const user = await User.findById(id).select("+password");
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const matches = typeof user.comparePassword === "function"
      ? await user.comparePassword(currentPassword)
      : await bcrypt.compare(currentPassword, user.password || "");

    if (!matches) return res.status(400).json({ ok: false, message: "Current password is incorrect" });

    // Hash new password if no pre-save hook
    if (user.schema?.methods?.comparePassword || user.isModified) {
      user.password = newPassword; // presave should handle hashing
    } else {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);
    }

    await user.save();
    res.json({ ok: true, message: "Password updated" });
  } catch (e) {
    console.error("[Admin] change-password error:", e);
    res.status(500).json({ ok: false, message: "Failed to change password" });
  }
});

/* -------------------------------- THEATERS -------------------------------- */
router.post("/theaters", requireAdmin, async (req, res) => {
  try {
    const { name, city, address } = req.body || {};
    if (!name || !city) return res.status(400).json({ message: "name and city are required" });

    const exists = await Theater.findOne({ name, city }).lean();
    if (exists) return res.status(409).json({ message: "Theater already exists in this city" });

    const theater = await Theater.create({ name, city, address });
    res.status(201).json(theater);
  } catch (e) {
    console.error("[Admin] create theater error:", e);
    res.status(500).json({ message: "Failed to create theater", error: e.message });
  }
});

router.get("/theaters", requireAdmin, async (_req, res) => {
  try {
    const theaters = await Theater.find().sort({ createdAt: -1 });
    res.json(theaters);
  } catch (e) {
    console.error("[Admin] load theaters error:", e);
    res.status(500).json({ message: "Failed to load theaters", error: e.message });
  }
});

router.get("/theaters/:id", requireAdmin, async (req, res) => {
  try {
    const theater = await Theater.findById(req.params.id);
    if (!theater) return res.status(404).json({ message: "Theater not found" });
    res.json(theater);
  } catch (e) {
    console.error("[Admin] get theater error:", e);
    res.status(500).json({ message: "Failed to fetch theater", error: e.message });
  }
});

router.delete("/theaters/:id", requireAdmin, async (req, res) => {
  try {
    const deleted = await Theater.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Theater not found" });
    res.json({ message: "Theater deleted successfully" });
  } catch (e) {
    console.error("[Admin] delete theater error:", e);
    res.status(500).json({ message: "Failed to delete theater", error: e.message });
  }
});

/* -------------------------------- SCREENS -------------------------------- */
router.post("/theaters/:id/screens", requireAdmin, async (req, res) => {
  try {
    const { name, rows, cols } = req.body || {};
    if (!name || !rows || !cols) {
      return res.status(400).json({ message: "name, rows, cols are required" });
    }
    const screen = await Screen.create({ theater: req.params.id, name, rows, cols });
    res.status(201).json(screen);
  } catch (e) {
    console.error("[Admin] create screen error:", e);
    res.status(500).json({ message: "Failed to create screen", error: e.message });
  }
});

router.get("/theaters/:id/screens", requireAdmin, async (req, res) => {
  try {
    const screens = await Screen.find({ theater: req.params.id }).sort({ createdAt: -1 });
    res.json(screens);
  } catch (e) {
    console.error("[Admin] load screens error:", e);
    res.status(500).json({ message: "Failed to load screens", error: e.message });
  }
});

/* ------------------------------- SHOWTIMES ------------------------------- */
router.get("/showtimes", requireAdmin, async (_req, res) => {
  try {
    const showtimes = await Showtime.find()
      .populate("movie", "title genre durationMins language")
      .populate("screen", "name rows cols")
      .populate("theater", "name city")
      .sort({ startTime: -1 });

    res.json(showtimes);
  } catch (e) {
    console.error("[Admin] load showtimes error:", e);
    res.status(500).json({ message: "Failed to load showtimes", error: e.message });
  }
});

router.post("/showtimes", requireAdmin, async (req, res) => {
  try {
    const { movie, screen: screenId, city, startTime, basePrice, rows, cols } = req.body || {};
    if (!movie || !screenId || !city || !startTime) {
      return res.status(400).json({ message: "movie, screen, city, startTime are required" });
    }

    const screen = await Screen.findById(screenId);
    if (!screen) return res.status(404).json({ message: "Screen not found" });

    const theater = screen.theater;
    const R = Number(rows ?? screen.rows);
    const C = Number(cols ?? screen.cols);
    if (!R || !C) return res.status(400).json({ message: "rows and cols are required (body or screen)" });

    const seats = [];
    for (let r = 1; r <= R; r++) for (let c = 1; c <= C; c++) seats.push({ row: r, col: c, status: "AVAILABLE" });

    const showtime = await Showtime.create({
      movie,
      screen: screenId,
      theater,
      city,
      startTime: new Date(startTime),
      basePrice,
      seats,
    });

    res.status(201).json(showtime);
  } catch (e) {
    console.error("[Admin] create showtime error:", e);
    res.status(500).json({ message: "Failed to create showtime", error: e.message });
  }
});

router.patch("/showtimes/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await Showtime.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ message: "Showtime not found" });
    res.json(updated);
  } catch (e) {
    console.error("[Admin] update showtime error:", e);
    res.status(500).json({ message: "Failed to update showtime", error: e.message });
  }
});

/* -------------------------------- PRICING -------------------------------- */
router.patch("/pricing/:showtimeId", requireAdmin, async (req, res) => {
  try {
    const { basePrice, multipliers } = req.body || {};
    const update = {};
    if (basePrice !== undefined) update.basePrice = basePrice;
    if (multipliers) update.multipliers = multipliers;

    const updated = await Showtime.findByIdAndUpdate(req.params.showtimeId, update, { new: true });
    if (!updated) return res.status(404).json({ message: "Showtime not found" });

    res.json({ message: "Pricing updated successfully!", showtime: updated });
  } catch (e) {
    console.error("[Admin] update pricing error:", e);
    res.status(500).json({ message: "Failed to update pricing", error: e.message });
  }
});

/* -------------------------------- REPORTS -------------------------------- */
router.get("/reports", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = {};

    if (from || to) {
      const createdAt = {};
      if (from) {
        const f = new Date(from);
        f.setHours(0, 0, 0, 0);
        createdAt.$gte = f;
      }
      if (to) {
        const t = new Date(to);
        t.setHours(23, 59, 59, 999);
        createdAt.$lte = t;
      }
      filter.createdAt = createdAt;
    }

    const bookings = await Booking.find(filter)
      .populate({
        path: "showtime",
        populate: [
          { path: "movie", select: "title" },
          { path: "theater", select: "name city" },
        ],
      })
      .sort({ createdAt: -1 });

    const revenue = bookings.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const countsByStatus = bookings.reduce((acc, b) => {
      const s = (b.status || "unknown").toLowerCase();
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    res.json({ count: bookings.length, revenue, countsByStatus, bookings });
  } catch (e) {
    console.error("[Admin] report error:", e);
    res.status(500).json({ message: "Failed to generate report", error: e.message });
  }
});

export default router;
