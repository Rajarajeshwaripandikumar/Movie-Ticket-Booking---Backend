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

import moviesRouter from "./movies.routes.js";

const router = Router();
const isId = (id) => mongoose.isValidObjectId(id);

const ADMIN_ROLES = ["SUPER_ADMIN", "THEATRE_ADMIN", "THEATER_ADMIN"];

/* -------------------------------------------------------------------------- */
/*                          DEBUG / USER PROFILE ROUTES                       */
/* -------------------------------------------------------------------------- */

router.get("/debug/me", requireAuth, (req, res) => res.json({ user: req.user }));

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

/* -------------------------------------------------------------------------- */
/*                              MOVIES MANAGEMENT                             */
/* -------------------------------------------------------------------------- */
router.use("/movies", requireAuth, requireRoles(...ADMIN_ROLES), moviesRouter);

/* -------------------------------------------------------------------------- */
/*                         THEATRE ADMIN MANAGEMENT                           */
/* -------------------------------------------------------------------------- */

router.get(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (_req, res) => {
    try {
      const admins = await User.find({ role: "THEATRE_ADMIN" })
        .select("_id name email role theatreId createdAt")
        .populate("theatreId", "name city")
        .sort({ createdAt: -1 })
        .lean();

      res.json(
        admins.map((a) => ({
          id: a._id,
          name: a.name,
          email: a.email,
          role: a.role,
          theatre: a.theatreId
            ? { id: a.theatreId._id, name: a.theatreId.name, city: a.theatreId.city }
            : null,
          createdAt: a.createdAt,
        }))
      );
    } catch (err) {
      res.status(500).json({ message: "Failed to load theatre admins" });
    }
  }
);

router.post(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { name, email, theatreId, password } = req.body;
      if (!name || !email || !theatreId)
        return res.status(400).json({ message: "name, email, theatreId required" });

      if (!isId(theatreId))
        return res.status(400).json({ message: "Invalid theatreId" });

      const existing = await User.findOne({ email }).lean();
      if (existing) return res.status(409).json({ message: "Email already in use" });

      const hashed = await bcrypt.hash(password || "changeme123", 10);
      const created = await User.create({
        name,
        email: email.toLowerCase().trim(),
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
      res.status(500).json({ message: "Failed to create theatre admin" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                              THEATRE MANAGEMENT                            */
/* -------------------------------------------------------------------------- */

router.post(
  "/theaters",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { name, city, address } = req.body;
      if (!name || !city) return res.status(400).json({ message: "name and city required" });

      const exists = await Theater.findOne({ name, city }).lean();
      if (exists) return res.status(409).json({ message: "Theatre already exists" });

      const theatre = await Theater.create({ name, city, address });
      res.status(201).json(theatre);
    } catch (err) {
      res.status(500).json({ message: "Failed to create theatre" });
    }
  }
);

router.get(
  "/theaters",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const query =
        req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN"
          ? { _id: req.user.theatreId }
          : {};
      res.json(await Theater.find(query).sort({ createdAt: -1 }).lean());
    } catch (err) {
      res.status(500).json({ message: "Failed to load theatres" });
    }
  }
);

router.get(
  "/theaters/:id",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const theatre = await Theater.findById(req.params.id).lean();
      if (!theatre) return res.status(404).json({ message: "Theatre not found" });
      res.json(theatre);
    } catch {
      res.status(500).json({ message: "Failed to load theatre" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                               SCREEN MANAGEMENT                            */
/* -------------------------------------------------------------------------- */

router.post(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    const { name, rows, cols, columns } = req.body;
    const R = Number(rows);
    const C = Number(cols ?? columns);
    if (!name || !R || !C) return res.status(400).json({ message: "Invalid input" });

    const screen = await Screen.create({
      theater: req.params.id,
      name: name.trim(),
      rows: R,
      columns: C,
    });

    res.status(201).json(screen);
  }
);

router.get(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    res.json(await Screen.find({ theater: req.params.id }).sort({ createdAt: -1 }).lean());
  }
);

/* -------------------------------------------------------------------------- */
/*                              SHOWTIME MANAGEMENT                           */
/* -------------------------------------------------------------------------- */

router.get(
  "/showtimes",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    const filter = {};
    if (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") {
      filter.theater = req.user.theatreId;
    }
    res.json(await Showtime.find(filter).populate("movie theater screen").lean());
  }
);

/* -------------------------------------------------------------------------- */
/*                               REPORTING API                                */
/* -------------------------------------------------------------------------- */

router.get(
  "/reports",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const bookings = await Booking.find()
        .populate({ path: "showtime", populate: ["movie", "theater"] })
        .lean();

      const filtered =
        req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN"
          ? bookings.filter(
              (b) =>
                String(b.showtime?.theater?._id || b.showtime?.theater) ===
                String(req.user.theatreId)
            )
          : bookings;

      const revenue = filtered.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);

      res.json({ count: filtered.length, revenue, bookings: filtered });
    } catch {
      res.status(500).json({ message: "Failed to generate report" });
    }
  }
);

export default router;
