// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";

// Prefer explicit imports if you have them, e.g.:
// import Booking from "../models/Booking.js";
// import Showtime from "../models/Showtime.js";
// import Theater from "../models/Theater.js";
// import Movie from "../models/Movie.js";

// Fallback to registry if models are already registered elsewhere
const Booking  = mongoose.models.Booking  || mongoose.model("Booking");
const Showtime = mongoose.models.Showtime || mongoose.model("Showtime");
const Theater  = mongoose.models.Theater  || mongoose.model("Theater");
const Movie    = mongoose.models.Movie    || mongoose.model("Movie");

const router = Router();

/* ------------------------------ helpers ------------------------------ */

// robust amount expression (supports totalAmount or amount, default 0)
const AMOUNT_EXPR = { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] };

// robust showtime reference
const SHOWTIME_ID = { $ifNull: ["$showtime", "$showtimeId"] };
// robust movie reference
const MOVIE_ID = { $ifNull: ["$movie", "$movieId"] };
// robust user reference
const USER_ID = { $ifNull: ["$user", "$userId"] };

// robust seats array on Booking (seats or seatsBooked)
const BOOKED_SEATS_ARR = { $ifNull: ["$seats", { $ifNull: ["$seatsBooked", []] }] };

const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

// group-by-day using $dateTrunc if available
const dayProject = [
  { $addFields: { _d: { $dateTrunc: { date: "$createdAt", unit: "day" } } } },
];

/* ========================  PRIMARY COMPOSITE ENDPOINT  ======================= */
/** GET /api/analytics
 * Returns:
 * {
 *   ok: true,
 *   revenue: [{ date, total }],
 *   users: [{ date, count }],
 *   occupancy: [{ theater, avgOccupancy }],
 *   popularMovies: [{ movie, bookings, revenue }]
 * }
 */
router.get("/", async (req, res, next) => {
  try {
    const days = Number(req.query.days || 7);
    const since = toPast(days);

    /* -------- Daily Revenue (confirmed/paid) -------- */
    const revenue = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          status: { $in: ["CONFIRMED", "PAID"] },
        },
      },
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

    /* -------- Daily Active Users -------- */
    const users = await Booking.aggregate([
      { $match: { createdAt: { $gte: since } } },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    /* -------- Theater Occupancy (average) --------
       booked seats from bookings vs total seats in showtime.seats (array length)  */
    const occupancy = await Showtime.aggregate([
      { $match: { startTime: { $gte: since } } }, // robust: if you use startAt, add an $or
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
          totalSeats: { $size: { $ifNull: ["$seats", []] } }, // showtime seats layout
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
    const popularMovies = await Booking.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] } } },
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

// 1) Revenue trends
router.get("/revenue/trends", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProject,
      { $group: { _id: "$_d", totalRevenue: { $sum: AMOUNT_EXPR }, bookings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// 2) Popular movies
router.get("/movies/popular", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);
    const data = await Booking.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] } } },
      { $group: { _id: MOVIE_ID, totalBookings: { $sum: 1 }, totalRevenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "m" } },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$m.title", "Unknown"] }, totalBookings: 1, totalRevenue: 1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// 3) Theater occupancy
router.get("/occupancy", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Showtime.aggregate([
      { $match: { startTime: { $gte: since } } },
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

// 4) Bookings by hour
router.get("/bookings/by-hour", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 14);
    const data = await Booking.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] } } },
      { $addFields: { hour: { $hour: "$createdAt" }, dow: { $dayOfWeek: "$createdAt" } } },
      { $group: { _id: { hour: "$hour", dow: "$dow" }, count: { $sum: 1 } } },
      { $project: { _id: 0, hour: "$_id.hour", dow: "$_id.dow", count: 1 } },
      { $sort: { dow: 1, hour: 1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// 5) Active users
router.get("/users/active", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      { $match: { createdAt: { $gte: since } } },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", dau: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);
    res.json(data);
  } catch (e) { next(e); }
});

// 6) Bookings summary
router.get("/bookings/summary", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      { $match: { createdAt: { $gte: since } } },
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
