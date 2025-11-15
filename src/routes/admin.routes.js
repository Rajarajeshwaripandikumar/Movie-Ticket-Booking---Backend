// backend/src/routes/admin.routes.js
import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import { requireTheaterOwnership } from "../middleware/ownership.js";

import User from "../models/User.js";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import Showtime from "../models/Showtime.js";
import Booking from "../models/Booking.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                                Helper Utils                                 */
/* -------------------------------------------------------------------------- */

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v));

/* ----------------------------- AUTH / DEBUG ------------------------------ */

// Basic token debug — any authenticated user can call
router.get("/debug/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// All admin routes require auth
router.use(requireAuth);

/* ----------------------------- PROFILE / ME ------------------------------ */

/**
 * GET /api/admin/me
 * Returns minimal profile for the current user.
 * Allowed roles: THEATER_ADMIN, SUPER_ADMIN
 */
router.get("/me", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const id = req.user?.id || req.user?._id;
    if (!id) return res.status(401).json({ message: "Unauthenticated" });

    const doc = await User.findById(id).lean();
    if (!doc) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, phone, theater, createdAt, updatedAt } = doc;
    return res.json({ id: _id, email, role, name, phone, theater, createdAt, updatedAt });
  } catch (e) {
    console.error("[Admin] /me error:", e);
    return res.status(500).json({ message: "Failed to fetch profile" });
  }
});

/**
 * PUT /api/admin/profile
 * Update safe fields for self (THEATER_ADMIN or SUPER_ADMIN)
 */
router.put("/profile", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const id = req.user?.id || req.user?._id;
    const allowed = ["name", "phone"];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    const updated = await User.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, phone, theater, createdAt, updatedAt } = updated;
    return res.json({ id: _id, email, role, name, phone, theater, createdAt, updatedAt });
  } catch (e) {
    console.error("[Admin] update profile error:", e);
    return res.status(500).json({ message: "Failed to update profile", error: e.message });
  }
});

/* ------------------------------- THEATERS -------------------------------- */

/**
 * POST /api/admin/theaters
 * SUPER_ADMIN only
 */
router.post("/theaters", requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const { name, city, address, contactEmail, contactPhone } = req.body || {};
    if (!name || !city) return res.status(400).json({ message: "name and city are required" });

    // enforce case-insensitive uniqueness by using the unique index on model
    const exists = await Theater.findOne({ name, city }).lean();
    if (exists) return res.status(409).json({ message: "Theater already exists in this city" });

    const theater = await Theater.create({ name, city, address, contactEmail, contactPhone, createdBy: req.user.id, status: "ACTIVE", isVerified: true });
    res.status(201).json(theater);
  } catch (e) {
    console.error("[Admin] create theater error:", e);
    res.status(500).json({ message: "Failed to create theater", error: e.message });
  }
});

/**
 * GET /api/admin/theaters
 * SUPER_ADMIN: list all theaters
 * THEATER_ADMIN: list only assigned theater
 */
router.get("/theaters", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    if (req.user.role === "SUPER_ADMIN") {
      const theaters = await Theater.find().sort({ createdAt: -1 });
      return res.json(theaters);
    }
    // THEATER_ADMIN
    const theater = await Theater.findOne({ theaterAdmin: req.user.id });
    if (!theater) return res.status(404).json({ message: "No theater assigned to you" });
    return res.json([theater]);
  } catch (e) {
    console.error("[Admin] load theaters error:", e);
    res.status(500).json({ message: "Failed to load theaters", error: e.message });
  }
});

/**
 * GET /api/admin/theaters/:id
 * SUPER_ADMIN: any theater
 * THEATER_ADMIN: only their theater
 */
router.get("/theaters/:id", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const t = await Theater.findById(req.params.id);
    if (!t) return res.status(404).json({ message: "Theater not found" });

    // theater admins may only fetch their assigned theater
    if (req.user.role === "THEATER_ADMIN" && String(t.theaterAdmin || "") !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    res.json(t);
  } catch (e) {
    console.error("[Admin] get theater error:", e);
    res.status(500).json({ message: "Failed to fetch theater", error: e.message });
  }
});

/**
 * DELETE /api/admin/theaters/:id
 * SUPER_ADMIN only
 */
router.delete("/theaters/:id", requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const deleted = await Theater.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Theater not found" });
    res.json({ message: "Theater deleted successfully" });
  } catch (e) {
    console.error("[Admin] delete theater error:", e);
    res.status(500).json({ message: "Failed to delete theater", error: e.message });
  }
});

/**
 * POST /api/admin/theaters/:id/assign-admin
 * SUPER_ADMIN only: assign a user as theater admin
 * body: { userId }
 */
router.post("/theaters/:id/assign-admin", requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId || !isObjectId(userId)) return res.status(400).json({ message: "userId required" });

    const theater = await Theater.findById(req.params.id);
    if (!theater) return res.status(404).json({ message: "Theater not found" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // promote user to THEATER_ADMIN
    user.role = "THEATER_ADMIN";
    user.theater = theater._id;
    await user.save();

    theater.theaterAdmin = user._id;
    await theater.save();

    res.json({ ok: true, theaterId: theater._id, adminId: user._id });
  } catch (e) {
    console.error("[Admin] assign-admin error:", e);
    res.status(500).json({ message: "Failed to assign admin", error: e.message });
  }
});

/* -------------------------------- SCREENS -------------------------------- */

/**
 * POST /api/admin/theaters/:id/screens
 * SUPER_ADMIN: can create for any theater
 * THEATER_ADMIN: can create only for their theater
 */
router.post(
  "/theaters/:id/screens",
  requireRole("THEATER_ADMIN", "SUPER_ADMIN"),
  // ownership middleware: for theater admins this will check the :id param
  requireTheaterOwnership("id"),
  async (req, res) => {
    try {
      const { name, rows, cols, seats, pricing, screenType } = req.body || {};
      if (!name) return res.status(400).json({ message: "name is required" });

      const screen = await Screen.create({
        theater: req.params.id,
        name,
        rows: rows || 0,
        cols: cols || 0,
        seats: Array.isArray(seats) ? seats : [],
        pricing: pricing || {},
        screenType: screenType || "2D",
      });

      res.status(201).json(screen);
    } catch (e) {
      console.error("[Admin] create screen error:", e);
      res.status(500).json({ message: "Failed to create screen", error: e.message });
    }
  }
);

/** GET /api/admin/theaters/:id/screens */
router.get("/theaters/:id/screens", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), requireTheaterOwnership("id"), async (req, res) => {
  try {
    const screens = await Screen.find({ theater: req.params.id }).sort({ createdAt: -1 });
    res.json(screens);
  } catch (e) {
    console.error("[Admin] load screens error:", e);
    res.status(500).json({ message: "Failed to load screens", error: e.message });
  }
});

/* ------------------------------- SHOWTIMES ------------------------------- */

/**
 * GET /api/admin/showtimes
 * SUPER_ADMIN: all showtimes
 * THEATER_ADMIN: showtimes for their theater only
 */
router.get("/showtimes", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === "THEATER_ADMIN") {
      const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
      if (!t) return res.status(403).json({ message: "No theater assigned" });
      filter.theater = t._id;
    }
    const showtimes = await Showtime.find(filter)
      .populate("movie", "title genres durationMins languages")
      .populate("screen", "name seats pricing screenType")
      .populate("theater", "name city")
      .sort({ startTime: -1 });

    res.json(showtimes);
  } catch (e) {
    console.error("[Admin] load showtimes error:", e);
    res.status(500).json({ message: "Failed to load showtimes", error: e.message });
  }
});

/**
 * POST /api/admin/showtimes
 * THEATER_ADMIN: may create showtimes for their theater
 * SUPER_ADMIN: may create for any theater
 *
 * Body: { movie, screen (id), startTime, durationMins, pricingOverrides, basePrice }
 */
router.post("/showtimes", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const { movie, screen: screenId, startTime, durationMins, pricingOverrides, basePrice } = req.body || {};
    if (!movie || !screenId || !startTime) return res.status(400).json({ message: "movie, screen, startTime required" });

    const screen = await Screen.findById(screenId).lean();
    if (!screen) return res.status(404).json({ message: "Screen not found" });

    // ownership: if theater admin, ensure they manage this screen's theater
    if (req.user.role === "THEATER_ADMIN") {
      const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
      if (!t || String(t._id) !== String(screen.theater)) {
        return res.status(403).json({ message: "Forbidden: you don't manage this theater" });
      }
    }

    // Build showtime
    const showtime = await Showtime.create({
      movie,
      theater: screen.theater,
      screen: screenId,
      startTime: new Date(startTime),
      durationMins: durationMins || undefined,
      pricingOverrides: pricingOverrides || [],
      basePrice: basePrice || screen.pricing?.REGULAR || 0,
    });

    // initialize seats snapshot from screen if necessary (method exists on model)
    if (typeof showtime.ensureSeatsInitialized === "function") {
      try {
        await showtime.ensureSeatsInitialized();
      } catch (err) {
        console.warn("Could not initialize seats:", err?.message || err);
      }
    }

    res.status(201).json(showtime);
  } catch (e) {
    console.error("[Admin] create showtime error:", e);
    res.status(500).json({ message: "Failed to create showtime", error: e.message });
  }
});

/**
 * PATCH /api/admin/showtimes/:id
 * THEATER_ADMIN: can update showtimes only in their theater
 * SUPER_ADMIN: can update any showtime
 */
router.patch("/showtimes/:id", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const showtime = await Showtime.findById(req.params.id).lean();
    if (!showtime) return res.status(404).json({ message: "Showtime not found" });

    if (req.user.role === "THEATER_ADMIN") {
      const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
      if (!t || String(t._id) !== String(showtime.theater)) {
        return res.status(403).json({ message: "Forbidden" });
      }
    }

    const updated = await Showtime.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (e) {
    console.error("[Admin] update showtime error:", e);
    res.status(500).json({ message: "Failed to update showtime", error: e.message });
  }
});

/* -------------------------------- PRICING -------------------------------- */

/**
 * PATCH /api/admin/pricing/:showtimeId
 * THEATER_ADMIN: only for their theater
 * SUPER_ADMIN: any
 */
router.patch("/pricing/:showtimeId", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const { basePrice, pricingOverrides } = req.body || {};
    const showtime = await Showtime.findById(req.params.showtimeId).lean();
    if (!showtime) return res.status(404).json({ message: "Showtime not found" });

    if (req.user.role === "THEATER_ADMIN") {
      const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
      if (!t || String(t._id) !== String(showtime.theater)) {
        return res.status(403).json({ message: "Forbidden" });
      }
    }

    const update = {};
    if (basePrice !== undefined) update.basePrice = basePrice;
    if (pricingOverrides !== undefined) update.pricingOverrides = pricingOverrides;

    const updated = await Showtime.findByIdAndUpdate(req.params.showtimeId, update, { new: true });
    res.json({ message: "Pricing updated successfully!", showtime: updated });
  } catch (e) {
    console.error("[Admin] update pricing error:", e);
    res.status(500).json({ message: "Failed to update pricing", error: e.message });
  }
});

/* -------------------------------- REPORTS -------------------------------- */

/**
 * GET /api/admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
 * SUPER_ADMIN: global report
 * THEATER_ADMIN: only their theater
 */
router.get("/reports", requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = {};

    // Time filter
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

    // Theater scoping
    if (req.user.role === "THEATER_ADMIN") {
      const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
      if (!t) return res.status(403).json({ message: "No theater assigned" });

      // find showtimes for their theater
      const showtimeIds = await Showtime.find({ theater: t._id }).distinct("_id");
      filter.showtime = { $in: showtimeIds };
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

    const revenue = bookings.reduce((sum, b) => sum + (Number(b.totalAmount || b.amount || 0) || 0), 0);
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
