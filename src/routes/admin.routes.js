// backend/src/routes/admin.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import {
  requireAuth,
  requireRoles,
  requireTheatreOwnership,
} from "../middleware/auth.js";

import User from "../models/User.js";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import Showtime from "../models/Showtime.js";
import Booking from "../models/Booking.js";

// Reuse your movies router for /api/admin/movies
import moviesRouter from "./movies.routes.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                          DEBUG / USER PROFILE ROUTES                       */
/* -------------------------------------------------------------------------- */

// Quick sanity check (returns decoded JWT user)
router.get("/debug/me", requireAuth, (req, res) => res.json({ user: req.user }));

// Get current admin profile
router.get("/me", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), async (req, res) => {
  try {
    const id = req.user?._id || req.user?.sub;
    if (!id) return res.status(401).json({ message: "Unauthenticated" });

    const doc = await User.findById(id).lean();
    if (!doc) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, phone, createdAt, updatedAt } = doc;
    res.json({ id: _id, email, role, name, phone, createdAt, updatedAt });
  } catch (err) {
    console.error("[Admin] /me error:", err);
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});

// Update admin profile
router.put("/profile", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), async (req, res) => {
  try {
    const id = req.user?._id || req.user?.sub;
    if (!id) return res.status(401).json({ message: "Unauthenticated" });

    const allowed = ["name", "phone"];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    const updated = await User.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, phone, createdAt, updatedAt } = updated;
    res.json({ id: _id, email, role, name, phone, createdAt, updatedAt });
  } catch (err) {
    console.error("[Admin] update profile error:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// Change password
router.post("/change-password", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 6)
      return res.status(400).json({ ok: false, message: "Invalid input" });

    const id = req.user?._id || req.user?.sub;
    const user = await User.findById(id).select("+password");
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const matches = await bcrypt.compare(currentPassword, user.password || "");
    if (!matches) return res.status(400).json({ ok: false, message: "Current password incorrect" });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ ok: true, message: "Password updated" });
  } catch (err) {
    console.error("[Admin] change-password error:", err);
    res.status(500).json({ ok: false, message: "Failed to change password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                              MOVIES MANAGEMENT                             */
/* -------------------------------------------------------------------------- */
router.use("/movies", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), moviesRouter);

/* -------------------------------------------------------------------------- */
/*                              THEATRE MANAGEMENT                            */
/* -------------------------------------------------------------------------- */

// ✅ SUPER_ADMIN — can create theatres
router.post("/theaters", requireAuth, requireRoles("SUPER_ADMIN"), async (req, res) => {
  try {
    const { name, city, address } = req.body || {};
    if (!name || !city) return res.status(400).json({ message: "name and city required" });

    const exists = await Theater.findOne({ name, city }).lean();
    if (exists) return res.status(409).json({ message: "Theatre already exists in this city" });

    const theatre = await Theater.create({ name, city, address });
    res.status(201).json(theatre);
  } catch (err) {
    console.error("[Admin] create theatre error:", err);
    res.status(500).json({ message: "Failed to create theatre", error: err.message });
  }
});

// ✅ BOTH SUPER_ADMIN and THEATRE_ADMIN (filtered for theatre-admin)
router.get("/theaters", requireAuth, requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"), async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "THEATRE_ADMIN") {
      query._id = req.user.theatreId;
    }
    const theatres = await Theater.find(query).sort({ createdAt: -1 });
    res.json(theatres);
  } catch (err) {
    console.error("[Admin] load theatres error:", err);
    res.status(500).json({ message: "Failed to load theatres", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                               SCREEN MANAGEMENT                            */
/* -------------------------------------------------------------------------- */
router.post(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const { name, rows, cols } = req.body || {};
      if (!name || !rows || !cols)
        return res.status(400).json({ message: "name, rows, cols required" });

      const screen = await Screen.create({ theater: req.params.id, name, rows, cols });
      res.status(201).json(screen);
    } catch (err) {
      console.error("[Admin] create screen error:", err);
      res.status(500).json({ message: "Failed to create screen", error: err.message });
    }
  }
);

router.get(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const screens = await Screen.find({ theater: req.params.id }).sort({ createdAt: -1 });
      res.json(screens);
    } catch (err) {
      console.error("[Admin] load screens error:", err);
      res.status(500).json({ message: "Failed to load screens", error: err.message });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                              SHOWTIME MANAGEMENT                           */
/* -------------------------------------------------------------------------- */
router.get(
  "/showtimes",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  async (req, res) => {
    try {
      const filter = {};
      if (req.user.role === "THEATRE_ADMIN") {
        filter.theater = req.user.theatreId;
      }

      const showtimes = await Showtime.find(filter)
        .populate("movie", "title genre durationMins language")
        .populate("screen", "name rows cols")
        .populate("theater", "name city")
        .sort({ startTime: -1 });

      res.json(showtimes);
    } catch (err) {
      console.error("[Admin] load showtimes error:", err);
      res.status(500).json({ message: "Failed to load showtimes", error: err.message });
    }
  }
);

router.post(
  "/showtimes",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const { movie, screen: screenId, city, startTime, basePrice, rows, cols } = req.body || {};
      if (!movie || !screenId || !city || !startTime)
        return res.status(400).json({ message: "movie, screen, city, startTime required" });

      const screen = await Screen.findById(screenId);
      if (!screen) return res.status(404).json({ message: "Screen not found" });

      const theater = screen.theater;
      const R = Number(rows ?? screen.rows);
      const C = Number(cols ?? screen.cols);
      if (!R || !C)
        return res.status(400).json({ message: "rows and cols required" });

      const seats = [];
      for (let r = 1; r <= R; r++) {
        for (let c = 1; c <= C; c++) seats.push({ row: r, col: c, status: "AVAILABLE" });
      }

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
    } catch (err) {
      console.error("[Admin] create showtime error:", err);
      res.status(500).json({ message: "Failed to create showtime", error: err.message });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                               REPORTS API                                  */
/* -------------------------------------------------------------------------- */
router.get(
  "/reports",
  requireAuth,
  requireRoles("SUPER_ADMIN", "THEATRE_ADMIN"),
  async (req, res) => {
    try {
      const { from, to } = req.query;
      const filter = {};

      if (from || to) {
        const createdAt = {};
        if (from) createdAt.$gte = new Date(from);
        if (to) {
          const t = new Date(to);
          t.setHours(23, 59, 59, 999);
          createdAt.$lte = t;
        }
        filter.createdAt = createdAt;
      }

      if (req.user.role === "THEATRE_ADMIN") {
        filter["showtime.theater"] = req.user.theatreId;
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
    } catch (err) {
      console.error("[Admin] report error:", err);
      res.status(500).json({ message: "Failed to generate report", error: err.message });
    }
  }
);

export default router;
