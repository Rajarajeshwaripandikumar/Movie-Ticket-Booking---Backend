// ==============================
// backend/src/routes/admin.routes.js (UPDATED)
// ==============================
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
const isId = (id) => mongoose.isValidObjectId(id);

// Accept both spellings everywhere
const ADMIN_ROLES = ["SUPER_ADMIN", "THEATRE_ADMIN", "THEATER_ADMIN"];

/* -------------------------------------------------------------------------- */
/*                          DEBUG / USER PROFILE ROUTES                       */
/* -------------------------------------------------------------------------- */

// Quick sanity check (returns decoded JWT user)
router.get("/debug/me", requireAuth, (req, res) => res.json({ user: req.user }));

// Get current admin profile
router.get(
  "/me",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
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
  }
);

// Update admin profile
router.put(
  "/profile",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const id = req.user?._id || req.user?.sub;
      if (!id) return res.status(401).json({ message: "Unauthenticated" });

      const allowed = ["name", "phone"];
      const update = {};
      for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

      const updated = await User.findByIdAndUpdate(id, update, {
        new: true,
        runValidators: true,
      }).lean();
      if (!updated) return res.status(404).json({ message: "Admin not found" });

      const { _id, email, role, name, phone, createdAt, updatedAt } = updated;
      res.json({ id: _id, email, role, name, phone, createdAt, updatedAt });
    } catch (err) {
      console.error("[Admin] update profile error:", err);
      res.status(500).json({ message: "Failed to update profile" });
    }
  }
);

// Change password
router.post(
  "/change-password",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
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
  }
);

/* -------------------------------------------------------------------------- */
/*                              MOVIES MANAGEMENT                             */
/* -------------------------------------------------------------------------- */
router.use("/movies", requireAuth, requireRoles(...ADMIN_ROLES), moviesRouter);

/* -------------------------------------------------------------------------- */
/*                         THEATRE ADMIN USER MANAGEMENT                      */
/* -------------------------------------------------------------------------- */

// List theatre admins (SUPER_ADMIN only)
router.get(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const admins = await User.find({ role: "THEATRE_ADMIN" })
        .select("_id name email role theatreId createdAt")
        .populate("theatreId", "name city")
        .sort({ createdAt: -1 })
        .lean();

      const rows = admins.map(a => ({
        id: a._id,
        name: a.name,
        email: a.email,
        role: a.role,
        theatre: a.theatreId
          ? { id: a.theatreId._id, name: a.theatreId.name, city: a.theatreId.city }
          : null,
        createdAt: a.createdAt,
      }));

      res.json(rows);
    } catch (err) {
      console.error("[Admin] list theatre admins error:", err);
      res.status(500).json({ message: "Failed to load theatre admins" });
    }
  }
);

// Create a theatre admin (SUPER_ADMIN only)
router.post(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { name, email, theatreId, password } = req.body || {};
      if (!name || !email || !theatreId) {
        return res.status(400).json({ message: "name, email, theatreId required" });
      }
      if (!isId(theatreId)) {
        return res.status(400).json({ message: "Invalid theatreId" });
      }

      const theatre = await Theater.findById(theatreId).lean();
      if (!theatre) return res.status(404).json({ message: "Theatre not found" });

      const existing = await User.findOne({ email: String(email).toLowerCase().trim() }).lean();
      if (existing) return res.status(409).json({ message: "Email already in use" });

      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(password || "changeme123", salt);

      const created = await User.create({
        name,
        email: String(email).toLowerCase().trim(),
        password: hashed,
        role: "THEATRE_ADMIN",
        theatreId,
      });

      const doc = await User.findById(created._id)
        .select("_id name email role theatreId createdAt")
        .populate("theatreId", "name city")
        .lean();

      res.status(201).json({
        id: doc._id,
        name: doc.name,
        email: doc.email,
        role: doc.role,
        theatre: doc.theatreId
          ? { id: doc.theatreId._id, name: doc.theatreId.name, city: doc.theatreId.city }
          : null,
        createdAt: doc.createdAt,
      });
    } catch (err) {
      console.error("[Admin] create theatre admin error:", err);
      res.status(500).json({ message: "Failed to create theatre admin", error: err.message });
    }
  }
);

// Update a theatre admin (name/theatreId and optional password)
router.put(
  "/theatre-admins/:id",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ message: "Invalid admin id" });

      const target = await User.findById(id).select("+password").lean();
      if (!target) return res.status(404).json({ message: "User not found" });
      if (target.role !== "THEATRE_ADMIN") {
        return res.status(400).json({ message: "Only THEATRE_ADMIN can be updated here" });
      }

      const update = {};
      if (req.body.name !== undefined) update.name = req.body.name;

      if (req.body.theatreId !== undefined) {
        if (!isId(req.body.theatreId)) return res.status(400).json({ message: "Invalid theatreId" });
        const th = await Theater.findById(req.body.theatreId).lean();
        if (!th) return res.status(404).json({ message: "Theatre not found" });
        update.theatreId = req.body.theatreId;
      }

      if (req.body.password) {
        const salt = await bcrypt.genSalt(10);
        update.password = await bcrypt.hash(req.body.password, salt);
      }

      const updated = await User.findByIdAndUpdate(id, update, { new: true })
        .select("_id name email role theatreId createdAt")
        .populate("theatreId", "name city")
        .lean();

      res.json({
        id: updated._id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        theatre: updated.theatreId
          ? { id: updated.theatreId._id, name: updated.theatreId.name, city: updated.theatreId.city }
          : null,
        createdAt: updated.createdAt,
      });
    } catch (err) {
      console.error("[Admin] update theatre admin error:", err);
      res.status(500).json({ message: "Failed to update theatre admin", error: err.message });
    }
  }
);

// Delete a theatre admin
router.delete(
  "/theatre-admins/:id",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ message: "Invalid admin id" });

      // prevent deleting self or any non-THEATRE_ADMIN via this route
      const target = await User.findById(id).lean();
      if (!target) return res.status(404).json({ message: "User not found" });
      if (String(target._id) === String(req.user._id || req.user.sub)) {
        return res.status(400).json({ message: "You cannot delete yourself" });
        }
      if (target.role !== "THEATRE_ADMIN") {
        return res.status(400).json({ message: "Only THEATRE_ADMIN can be deleted here" });
      }

      await User.findByIdAndDelete(id);
      res.json({ success: true });
    } catch (err) {
      console.error("[Admin] delete theatre admin error:", err);
      res.status(500).json({ message: "Failed to delete theatre admin", error: err.message });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                              THEATRE MANAGEMENT                            */
/* -------------------------------------------------------------------------- */

// SUPER_ADMIN — create theatres
router.post(
  "/theaters",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
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
  }
);

// SUPER_ADMIN & THEATRE_ADMIN — list theatres (theatre-admin sees only their own)
router.get(
  "/theaters",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const query = req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN"
        ? { _id: req.user.theatreId }
        : {};
      const theatres = await Theater.find(query).sort({ createdAt: -1 }).lean();
      res.json(theatres);
    } catch (err) {
      console.error("[Admin] load theatres error:", err);
      res.status(500).json({ message: "Failed to load theatres", error: err.message });
    }
  }
);

// NEW: get single theatre by id (used by your UI)
router.get(
  "/theaters/:id",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ message: "Invalid theater id" });
      const theatre = await Theater.findById(id).lean();
      if (!theatre) return res.status(404).json({ message: "Theatre not found" });
      res.json(theatre);
    } catch (err) {
      console.error("[Admin] get theatre error:", err);
      res.status(500).json({ message: "Failed to load theatre", error: err.message });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                               SCREEN MANAGEMENT                            */
/* -------------------------------------------------------------------------- */

// Create screen for a theatre (uses standardized 'columns')
router.post(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership, // ensures theatre-admin can only touch their theatre
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ message: "Invalid theater id" });

      const { name, rows, cols, columns } = req.body || {};
      const R = Number(rows);
      const C = Number(cols ?? columns);
      if (!name || !R || !C) {
        return res.status(400).json({ message: "name, rows, columns (or cols) required" });
      }
      if (R <= 0 || C <= 0) {
        return res.status(400).json({ message: "rows and columns must be positive numbers" });
      }

      // Store as 'columns' to be consistent with screens.routes.js
      const screen = await Screen.create({
        theater: id,
        name: String(name).trim(),
        rows: R,
        columns: C,
      });

      res.status(201).json(screen);
    } catch (err) {
      console.error("[Admin] create screen error:", err);
      if (err?.code === 11000) {
        return res.status(409).json({ message: "Screen name already exists for this theater" });
      }
      res.status(500).json({ message: "Failed to create screen", error: err.message });
    }
  }
);

// List screens for a theatre
router.get(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ message: "Invalid theater id" });

      const screens = await Screen.find({ theater: id }).sort({ createdAt: -1 }).lean();
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

// List showtimes (THEATRE_ADMIN scoped to their theatre)
router.get(
  "/showtimes",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const filter = {};
      if (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") {
        filter.theater = req.user.theatreId;
      }

      const showtimes = await Showtime.find(filter)
        .populate("movie", "title genres runtime languages censorRating")
        .populate("screen", "name rows columns")
        .populate("theater", "name city")
        .sort({ startTime: -1 })
        .lean();

      res.json(showtimes);
    } catch (err) {
      console.error("[Admin] load showtimes error:", err);
      res.status(500).json({ message: "Failed to load showtimes", error: err.message });
    }
  }
);

// Create showtime (seats initialized from screen.rows/columns)
router.post(
  "/showtimes",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const { movie, screen: screenId, startTime, basePrice } = req.body || {};
      if (!movie || !screenId || !startTime || basePrice == null) {
        return res
          .status(400)
          .json({ message: "movie, screen, startTime, basePrice are required" });
      }

      // Validate screen
      const screen = await Screen.findById(screenId).lean();
      if (!screen) return res.status(404).json({ message: "Screen not found" });

      // Ownership check for THEATRE_ADMIN
      if (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") {
        if (String(screen.theater) !== String(req.user.theatreId)) {
          return res.status(403).json({ message: "Forbidden" });
        }
      }

      // Derive theater + city from screen.theater
      const theater = await Theater.findById(screen.theater).select("city").lean();
      if (!theater) return res.status(400).json({ message: "Theater missing for screen" });

      // Time normalization: minute precision
      const when = new Date(startTime);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ message: "Invalid startTime" });
      when.setSeconds(0, 0);

      const rows = Number(screen.rows) || 10;
      const cols = Number(screen.columns ?? screen.cols) || 10;

      // Initialize seats on create for admin tool
      const seats = [];
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) seats.push({ row: r, col: c, status: "AVAILABLE" });
      }

      const doc = await Showtime.create({
        movie,
        screen: screenId,
        theater: screen.theater,
        city: theater.city,
        startTime: when,
        basePrice: Number(basePrice),
        seats,
      });

      const populated = await Showtime.findById(doc._id)
        .populate("movie", "title genres runtime languages censorRating")
        .populate("screen", "name rows columns")
        .populate("theater", "name city")
        .lean();

      res.status(201).json(populated);
    } catch (err) {
      console.error("[Admin] create showtime error:", err);
      if (err?.code === 11000) {
        return res.status(409).json({ message: "Showtime already exists for this screen & minute" });
      }
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
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const { from, to } = req.query;

      // Base filter by date
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

      // If theatre admin, scope to their theatre via showtime.theater
      const bookings = await Booking.find(filter)
        .populate({
          path: "showtime",
          populate: [
            { path: "movie", select: "title" },
            { path: "theater", select: "name city" },
          ],
        })
        .sort({ createdAt: -1 })
        .lean();

      const scoped =
        (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN")
          ? bookings.filter(
              b =>
                b.showtime &&
                String(b.showtime.theater?._id || b.showtime.theater) ===
                  String(req.user.theatreId)
            )
          : bookings;

      const revenue = scoped.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
      const countsByStatus = scoped.reduce((acc, b) => {
        const s = (b.status || "unknown").toLowerCase();
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {});

      res.json({ count: scoped.length, revenue, countsByStatus, bookings: scoped });
    } catch (err) {
      console.error("[Admin] report error:", err);
      res.status(500).json({ message: "Failed to generate report", error: err.message });
    }
  }
);

export default router;


// ==============================
// backend/src/middleware/auth.js (ONLY the ownership helper shown)
// ==============================
// Ensure this is exported from your existing auth middleware file
export function requireTheatreOwnership(req, res, next) {
  try {
    // SUPER_ADMIN bypasses ownership checks
    const role = String(req.user?.role || "");
    if (role === "SUPER_ADMIN") return next();

    const userTheatre = String(req.user?.theatreId || "");
    const pathId = String(
      req.params.id ||
      req.body.theater ||
      req.body.theatreId ||
      req.query.theater ||
      req.query.theatreId ||
      ""
    );

    if (!userTheatre || !pathId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (userTheatre !== pathId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  } catch (e) {
    console.error("[Auth] requireTheatreOwnership error:", e);
    res.status(500).json({ message: "Ownership check failed" });
  }
}


// ==============================
// backend/src/app.js (MINIMAL TWEAKS ONLY)
// ==============================
// 1) Reuse same corsOptions for app.use and app.options
// 2) Optional: singular alias for /api/theatre/* → /api/theaters/*

// ... keep your existing imports and setup

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn("[CORS] ❌ Blocked:", origin);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Idempotency-Key",
    "X-Intent",
    "X-Requested-With",
  ],
  exposedHeaders: ["Content-Length", "Content-Type"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Singular UK → US alias (safety net for stray frontend calls)
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/theatre/")) {
    req.url = req.url.replace(/^\/api\/theatre\b/, "/api/theaters");
  }
  next();
});
