// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";

// Prefer explicit imports to avoid model name issues
import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import Theater from "../models/Theater.js";
import Movie from "../models/Movie.js";

const router = Router();

/* ------------------------------ helpers ------------------------------ */

const AMOUNT_EXPR = { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] };
const SHOWTIME_ID = { $ifNull: ["$showtime", "$showtimeId"] };
const MOVIE_ID = { $ifNull: ["$movie", "$movieId"] };
const USER_ID = { $ifNull: ["$user", "$userId"] };

const toPast = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - Number(days));
  d.setHours(0, 0, 0, 0);
  return d;
};

// Use $dateTrunc if available; otherwise fallback to $dateToString day
const dayProject = [
  {
    $addFields: {
      _d: {
        $cond: [
          { $gt: [{ $type: "$createdAt" }, "missing"] },
          {
            $dateTrunc: { date: "$createdAt", unit: "day" },
          },
          null,
        ],
      },
    },
  },
  {
    $addFields: {
      _d: {
        $ifNull: [
          "$_d",
          { $dateFromString: { dateString: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } } } },
        ],
      },
    },
  },
];

/* --------------------------- middleware wrapper ------------------------- */
/**
 * Helper to resolve theater scope:
 * - if user is THEATER_ADMIN -> return their theater id (or 403 if none)
 * - if SUPER_ADMIN -> use req.query.theaterId if provided, else null (global)
 */
async function resolveTheaterScope(req, res) {
  if (req.user.role === "THEATER_ADMIN") {
    const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
    if (!t) {
      res.status(403).json({ message: "No theater assigned to this admin" });
      return null;
    }
    return t._id;
  } else if (req.user.role === "SUPER_ADMIN") {
    return req.query.theaterId ? (mongoose.Types.ObjectId.isValid(req.query.theaterId) ? req.query.theaterId : null) : null;
  }
  // default deny
  res.status(403).json({ message: "Forbidden" });
  return null;
}

/* ========================  PRIMARY COMPOSITE ENDPOINT  ======================= */
/**
 * GET /api/analytics
 * Query params:
 *  - days (default 7)
 *  - theaterId (SUPER_ADMIN only; THEATER_ADMIN ignored)
 */
router.get("/", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const days = Number(req.query.days || 7);
    const since = toPast(days);

    // resolve theater scope
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return; // response already sent in resolveTheaterScope
    const theaterFilter = theaterScope ? { theater: mongoose.Types.ObjectId(theaterScope) } : {};

    /* -------- Daily Revenue (confirmed/paid) -------- */
    const revenueMatch = {
      createdAt: { $gte: since },
      status: { $in: ["CONFIRMED", "PAID"] },
      ... (theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}),
    };

    const revenue = await Booking.aggregate([
      { $match: revenueMatch },
      ...dayProject,
      {
        $group: {
          _id: "$_d",
          total: { $sum: AMOUNT_EXPR },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", total: 1 } },
    ]);

    /* -------- Daily Active Users (bookers) -------- */
    const usersMatch = {
      createdAt: { $gte: since },
      ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}),
    };

    const users = await Booking.aggregate([
      { $match: usersMatch },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    /* -------- Theater Occupancy (average) -------- */
    // If theater scoped, compute only for that theater
    const occupancyMatch = { startTime: { $gte: since }, ...(theaterScope ? { theater: mongoose.Types.ObjectId(theaterScope) } : {}) };

    const occupancy = await Showtime.aggregate([
      { $match: occupancyMatch },
      {
        $lookup: {
          from: "bookings",
          localField: "_id",
          foreignField: "showtime",
          as: "bks",
        },
      },
      {
        $project: {
          theater: 1,
          totalSeats: { $size: { $ifNull: ["$seats", []] } },
          booked: {
            $sum: {
              $map: {
                input: "$bks",
                as: "b",
                in: { $size: { $ifNull: ["$$b.seats", { $ifNull: ["$$b.seatsBooked", []] }] } },
              },
            },
          },
        },
      },
      {
        $lookup: {
          from: "theaters",
          localField: "theater",
          foreignField: "_id",
          as: "t",
        },
      },
      { $unwind: "$t" },
      {
        $group: {
          _id: "$t.name",
          avgOccupancy: {
            $avg: {
              $cond: [{ $gt: ["$totalSeats", 0] }, { $divide: ["$booked", "$totalSeats"] }, 0],
            },
          },
        },
      },
      { $project: { _id: 0, theater: "$_id", avgOccupancy: 1 } },
      { $sort: { avgOccupancy: -1 } },
    ]);

    /* -------- Popular Movies (bookings + revenue) -------- */
    const popularMatch = {
      createdAt: { $gte: since },
      status: { $in: ["CONFIRMED", "PAID"] },
      ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}),
    };

    const popularMovies = await Booking.aggregate([
      { $match: popularMatch },
      {
        $group: {
          _id: MOVIE_ID,
          bookings: { $sum: 1 },
          revenue: { $sum: AMOUNT_EXPR },
        },
      },
      { $sort: { bookings: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "movies",
          localField: "_id",
          foreignField: "_id",
          as: "movie",
        },
      },
      { $unwind: { path: "$movie", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movie: { $ifNull: ["$movie.title", "Unknown"] },
          bookings: 1,
          revenue: 1,
        },
      },
    ]);

    res.json({ ok: true, revenue, users, occupancy, popularMovies });
  } catch (err) {
    next(err);
  }
});

/* ===========================  GRANULAR ENDPOINTS  =========================== */

// Revenue trends (role aware)
router.get("/revenue/trends", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;
    const match = {
      createdAt: { $gte: since },
      status: { $in: ["CONFIRMED", "PAID"] },
      ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}),
    };

    const data = await Booking.aggregate([
      { $match: match },
      ...dayProject,
      { $group: { _id: "$_d", totalRevenue: { $sum: AMOUNT_EXPR }, bookings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// Popular movies (role aware)
router.get("/movies/popular", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const match = {
      createdAt: { $gte: since },
      status: { $in: ["CONFIRMED", "PAID"] },
      ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}),
    };

    const data = await Booking.aggregate([
      { $match: match },
      { $group: { _id: MOVIE_ID, totalBookings: { $sum: 1 }, totalRevenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "m" } },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$m.title", "Unknown"] }, totalBookings: 1, totalRevenue: 1 } },
    ]);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// Theater occupancy
router.get("/occupancy", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const match = { startTime: { $gte: since }, ...(theaterScope ? { theater: mongoose.Types.ObjectId(theaterScope) } : {}) };

    const data = await Showtime.aggregate([
      { $match: match },
      { $lookup: { from: "bookings", localField: "_id", foreignField: "showtime", as: "bks" } },
      {
        $project: {
          theater: 1,
          totalSeats: { $size: { $ifNull: ["$seats", []] } },
          booked: {
            $sum: {
              $map: {
                input: "$bks",
                as: "b",
                in: { $size: { $ifNull: ["$$b.seats", { $ifNull: ["$$b.seatsBooked", []] }] } },
              },
            },
          },
        },
      },
      { $lookup: { from: "theaters", localField: "theater", foreignField: "_id", as: "t" } },
      { $unwind: "$t" },
      {
        $group: {
          _id: "$t.name",
          occupancyRate: {
            $avg: {
              $cond: [{ $gt: ["$totalSeats", 0] }, { $divide: ["$booked", "$totalSeats"] }, 0],
            },
          },
        },
      },
      { $project: { _id: 0, theaterName: "$_id", occupancyRate: 1 } },
      { $sort: { occupancyRate: -1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// Bookings by hour
router.get("/bookings/by-hour", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 14);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const match = { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] }, ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}) };

    const data = await Booking.aggregate([
      { $match: match },
      { $addFields: { hour: { $hour: "$createdAt" }, dow: { $dayOfWeek: "$createdAt" } } },
      { $group: { _id: { hour: "$hour", dow: "$dow" }, count: { $sum: 1 } } },
      { $project: { _id: 0, hour: "$_id.hour", dow: "$_id.dow", count: 1 } },
      { $sort: { dow: 1, hour: 1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// Active users (DAU)
router.get("/users/active", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const match = { createdAt: { $gte: since }, ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}) };

    const data = await Booking.aggregate([
      { $match: match },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", dau: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// Bookings summary
router.get("/bookings/summary", requireAuth, requireRole("THEATER_ADMIN", "SUPER_ADMIN"), async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const match = { createdAt: { $gte: since }, ...(theaterScope ? { showtime: { $in: await Showtime.find({ theater: theaterScope }).distinct("_id") } } : {}) };

    const data = await Booking.aggregate([
      { $match: match },
      ...dayProject,
      {
        $group: {
          _id: "$_d",
          confirmed: { $sum: { $cond: [{ $in: ["$status", ["CONFIRMED", "PAID"]] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $in: ["$status", ["CONFIRMED", "PAID"]] }, AMOUNT_EXPR, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
