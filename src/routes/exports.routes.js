// backend/src/routes/exports.routes.js
import express from "express";
import { Parser } from "json2csv";
import mongoose from "mongoose";

import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import Movie from "../models/Movie.js";
import Theater from "../models/Theater.js";

import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";

const router = express.Router();

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const DAY_TRUNC_EXPR = { $dateTrunc: { date: "$createdAt", unit: "day" } };

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/* ----------------------------------------------------------------------------
   GET /api/exports/revenue.csv
   SUPER_ADMIN  → can see all theaters
   THEATER_ADMIN → only their theater
---------------------------------------------------------------------------- */
router.get(
  "/revenue.csv",
  requireAuth,
  requireRole("SUPER_ADMIN", "THEATER_ADMIN"),
  async (req, res) => {
    try {
      const { from, to, theater, city } = req.query;
      const filter = { status: "CONFIRMED" };

      // Date filtering
      const fromD = toDateOrNull(from);
      const toD = toDateOrNull(to);
      if (fromD || toD) {
        filter.createdAt = {};
        if (fromD) filter.createdAt.$gte = fromD;
        if (toD) {
          toD.setHours(23, 59, 59, 999);
          filter.createdAt.$lte = toD;
        }
      }

      // THEATER_ADMIN overrides query
      if (req.user.role === "THEATER_ADMIN") {
        filter["showtime.theater"] = new mongoose.Types.ObjectId(req.user.theater);
      } else {
        // SUPER_ADMIN can filter by ?theater=
        if (theater && mongoose.isValidObjectId(theater)) {
          filter["showtime.theater"] = new mongoose.Types.ObjectId(theater);
        }
      }

      if (city) {
        filter["showtime.city"] = city;
      }

      // Build aggregation
      const data = await Booking.aggregate([
        { $match: filter },

        // Join showtime
        {
          $lookup: {
            from: "showtimes",
            localField: "showtime",
            foreignField: "_id",
            as: "showtime",
          },
        },
        { $unwind: "$showtime" },

        // Day truncation
        { $addFields: { day: DAY_TRUNC_EXPR } },

        // Group per day
        {
          $group: {
            _id: "$day",
            revenue: { $sum: "$amount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const parser = new Parser({
        fields: ["_id", "revenue", "bookings"],
      });

      const csv = parser.parse(data);
      res.header("Content-Type", "text/csv");
      res.attachment("revenue.csv");
      return res.send(csv);
    } catch (e) {
      console.error("EXPORT /revenue.csv error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* ----------------------------------------------------------------------------
   GET /api/exports/movie-revenue.csv
---------------------------------------------------------------------------- */
router.get(
  "/movie-revenue.csv",
  requireAuth,
  requireRole("SUPER_ADMIN", "THEATER_ADMIN"),
  async (req, res) => {
    try {
      const filter = { status: "CONFIRMED" };

      // THEATER_ADMIN applies theater filter
      if (req.user.role === "THEATER_ADMIN") {
        filter["showtime.theater"] = new mongoose.Types.ObjectId(req.user.theater);
      }

      const data = await Booking.aggregate([
        { $match: filter },

        {
          $lookup: {
            from: "showtimes",
            localField: "showtime",
            foreignField: "_id",
            as: "showtime",
          },
        },
        { $unwind: "$showtime" },

        {
          $lookup: {
            from: "movies",
            localField: "showtime.movie",
            foreignField: "_id",
            as: "movie",
          },
        },
        { $unwind: "$movie" },

        {
          $group: {
            _id: "$movie.title",
            revenue: { $sum: "$amount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
      ]);

      const parser = new Parser({
        fields: ["_id", "revenue", "bookings"],
      });

      const csv = parser.parse(data);
      res.header("Content-Type", "text/csv");
      res.attachment("movie-revenue.csv");
      return res.send(csv);
    } catch (e) {
      console.error("EXPORT movie revenue error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* ----------------------------------------------------------------------------
   GET /api/exports/showtime-report.csv
---------------------------------------------------------------------------- */
router.get(
  "/showtime-report.csv",
  requireAuth,
  requireRole("SUPER_ADMIN", "THEATER_ADMIN"),
  async (req, res) => {
    try {
      const filter = {};

      if (req.user.role === "THEATER_ADMIN") {
        filter["theater"] = new mongoose.Types.ObjectId(req.user.theater);
      }

      const data = await Showtime.aggregate([
        { $match: filter },

        {
          $lookup: {
            from: "movies",
            localField: "movie",
            foreignField: "_id",
            as: "movie",
          },
        },
        { $unwind: "$movie" },

        {
          $lookup: {
            from: "theaters",
            localField: "theater",
            foreignField: "_id",
            as: "theater",
          },
        },
        { $unwind: "$theater" },

        {
          $project: {
            movie: "$movie.title",
            theater: "$theater.name",
            city: "$theater.city",
            screen: "$screen",
            startTime: 1,
            basePrice: 1,
          },
        },

        { $sort: { startTime: 1 } },
      ]);

      const parser = new Parser({
        fields: ["movie", "theater", "city", "screen", "startTime", "basePrice"],
      });

      const csv = parser.parse(data);
      res.header("Content-Type", "text/csv");
      res.attachment("showtime-report.csv");
      return res.send(csv);
    } catch (e) {
      console.error("EXPORT showtime-report error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

export default router;
