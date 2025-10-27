// backend/src/routes/analytics.routes.js — patched (defensive createdAt normalization + field-path fixes)
import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

// Prefer explicit imports if you have them e.g. import Booking from "../models/Booking.js";
const Booking  = mongoose.models.Booking  || mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
const Showtime = mongoose.models.Showtime || mongoose.model("Showtime", new mongoose.Schema({}, { strict: false }));
const Theater  = mongoose.models.Theater  || mongoose.model("Theater", new mongoose.Schema({}, { strict: false }));
const Movie    = mongoose.models.Movie    || mongoose.model("Movie", new mongoose.Schema({}, { strict: false }));

const router = Router();

/* ------------------------------ helpers ------------------------------ */
// robust amount expression (supports totalAmount or amount, default 0) and coerces to double
const AMOUNT_EXPR = { $toDouble: { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] } };

// robust refs
const SHOWTIME_ID = { $ifNull: ["$showtime", "$showtimeId"] };
const MOVIE_ID = { $ifNull: ["$movie", "$movieId"] };
const USER_ID = { $ifNull: ["$user", "$userId"] };

const BOOKED_SEATS_ARR = { $ifNull: ["$seats", { $ifNull: ["$seatsBooked", []] }] };

const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

// Defensive normalizeCreatedAtStage — safe conversion from date/number/string and avoids throwing
const normalizeCreatedAtStage = [
  {
    $addFields: {
      __created_raw: { $ifNull: ["$createdAt", "$created_at", "$createdAt", "$createdAtRaw"] },
    },
  },
  {
    $addFields: {
      createdAt: {
        $switch: {
          branches: [
            { case: { $eq: [{ $type: "$__created_raw" }, "date"] }, then: "$__created_raw" },
            { case: { $in: [{ $type: "$__created_raw" }, ["int", "long", "double", "decimal"]] }, then: { $toDate: "$__created_raw" } },
            {
              case: { $eq: [{ $type: "$__created_raw" }, "string"] },
              then: {
                $dateFromString: {
                  dateString: { $trim: { input: "$__created_raw" } },
                  onError: null,
                  onNull: null
                }
              }
            }
          ],
          default: { $ifNull: ["$createdAt", null] }
        }
      }
    }
  },
  { $project: { __created_raw: 0 } },
];

// group-by-day using $dateTrunc if available, else fallback to $dateToString
const dayProject = [
  {
    $addFields: {
      _d: {
        $cond: [
          { $function: { body: function() { return false; }, args: [], lang: "js" } }, // placeholder to keep consistent shape; replaced below if server supports dateTrunc
          { $dateTrunc: { date: "$createdAt", unit: "day" } },
          { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        ]
      }
    }
  }
];

// Some Mongo servers do not allow $function check here; we'll simply use $dateToString (string) in projections
// Replace dayProject with a leaner form that yields a consistent string key used in grouping
const dayProjectSimple = [
  { $addFields: { _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
];

/* ========================  PRIMARY COMPOSITE ENDPOINT  ======================= */
router.get("/", async (req, res, next) => {
  try {
    const days = Number(req.query.days || 7);
    const since = toPast(days);

    /* -------- Daily Revenue (confirmed/paid) -------- */
    const revenue = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      // normalize status check (case-insensitive)
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProjectSimple,
      { $addFields: { __amount_safe: AMOUNT_EXPR } },
      { $group: { _id: "$_d", total: { $sum: "$__amount_safe" } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", total: 1 } },
    ]);

    /* -------- Daily Active Users -------- */
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    /* -------- Theater Occupancy (average) -------- */
    const occupancy = await Showtime.aggregate([
      { $match: { startTime: { $gte: since } } },
      {
        $lookup: {
          from: "bookings",
          let: { sid: "$_id", sidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [ { $eq: ["$showtime", "$$sid"] }, { $eq: ["$showtime", "$$sidStr"] }, { $eq: ["$showtimeId", "$$sid"] }, { $eq: ["$showtimeId", "$$sidStr"] } ] } } },
            { $project: { seats: 1, seatsBooked: 1, quantity: 1 } }
          ],
          as: "bks",
        },
      },
      { $lookup: { from: "theaters", localField: "theater", foreignField: "_id", as: "t" } },
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          showtimeSeatsCount: { $size: { $ifNull: ["$seats", []] } },
          showtimeCapacity: { $ifNull: ["$capacity", "$totalSeats", null] },
          theaterCapacity: { $ifNull: ["$t.capacity", "$t.totalSeats", null] }
        }
      },
      {
        $addFields: {
          totalSeats: {
            $cond: [
              { $gt: ["$showtimeSeatsCount", 0] },
              "$showtimeSeatsCount",
              { $cond: [ { $gt: ["$showtimeCapacity", null] }, "$showtimeCapacity", { $ifNull: ["$theaterCapacity", 0] } ] }
            ]
          }
        }
      },
      {
        $addFields: {
          booked: {
            $sum: {
              $map: {
                input: { $ifNull: ["$bks", []] },
                as: "b",
                in: {
                  $let: {
                    vars: {
                      seatsArraySize: { $size: { $ifNull: ["$$b.seats", []] } },
                      seatsBookedNum: { $ifNull: ["$$b.seatsBooked", null] },
                      qtyNum: { $ifNull: ["$$b.quantity", null] }
                    },
                    in: {
                      $cond: [
                        { $gt: ["$$seatsArraySize", 0] },
                        "$$seatsArraySize",
                        { $cond: [ { $ne: ["$$seatsBookedNum", null] }, "$$seatsBookedNum", { $cond: [ { $ne: ["$$qtyNum", null] }, "$$qtyNum", 1 ] } ] }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      },
      {
        $group: {
          _id: { name: { $ifNull: ["$t.name", "$t.title", "$t.displayName", "$t.label", "Unknown"] } },
          occupancyRate: { $avg: { $cond: [ { $gt: ["$totalSeats", 0] }, { $divide: ["$booked", "$totalSeats"] }, 0 ] } }
        }
      },
      { $project: { _id: 0, theaterName: "$_id.name", occupancyRate: 1 } },
      { $sort: { occupancyRate: -1 } }
    ]);

    /* -------- Popular Movies (bookings + revenue) -------- */
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      {
        $group: {
          _id: MOVIE_ID,
          bookings: { $sum: 1 },
          revenue: { $sum: AMOUNT_EXPR },
        },
      },
      { $sort: { bookings: -1 } },
      { $limit: 5 },
      { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "movie" } },
      { $unwind: { path: "$movie", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movie: { $ifNull: ["$movie.title", "Unknown"] }, bookings: 1, revenue: 1 } }
    ]);

    res.json({ ok: true, revenue, users, occupancy, popularMovies });
  } catch (err) {
    debug("analytics error:", err && (err.stack || err.message));
    next(err);
  }
});

/* ===========================  GRANULAR ENDPOINTS  =========================== */

// 1) Revenue trends
router.get("/revenue/trends", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProjectSimple,
      { $addFields: { __amount_safe: AMOUNT_EXPR } },
      { $group: { _id: "$_d", totalRevenue: { $sum: "$__amount_safe" }, bookings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { debug("revenue/trends error:", e && e.message); next(e); }
});

// 2) Popular movies
router.get("/movies/popular", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      { $group: { _id: MOVIE_ID, totalBookings: { $sum: 1 }, totalRevenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "m" } },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$m.title", "Unknown"] }, totalBookings: 1, totalRevenue: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("movies/popular error:", e && e.message); next(e); }
});

// 3) Theater occupancy
router.get("/occupancy", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Showtime.aggregate([
      { $match: { startTime: { $gte: since } } },
      {
        $lookup: {
          from: "bookings",
          let: { sid: "$_id", sidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [ { $eq: ["$showtime", "$$sid"] }, { $eq: ["$showtime", "$$sidStr"] }, { $eq: ["$showtimeId", "$$sid"] }, { $eq: ["$showtimeId", "$$sidStr"] } ] }, createdAt: { $gte: since } } },
            { $project: { seats: 1, seatsBooked: 1, quantity: 1 } }
          ],
          as: "bks"
        }
      },
      {
        $project: {
          theater: 1,
          totalSeats: { $size: { $ifNull: ["$seats", []] } },
          booked: { $sum: { $map: { input: { $ifNull: ["$bks", []] }, as: "b", in: { $size: { $ifNull: ["$$b.seats", { $ifNull: ["$$b.seatsBooked", []] }] } } } } }
        }
      },
      { $lookup: { from: "theaters", localField: "theater", foreignField: "_id", as: "t" } },
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$t.name", occupancyRate: { $avg: { $cond: [ { $gt: ["$totalSeats", 0] }, { $divide: ["$booked", "$totalSeats"] }, 0 ] } } } },
      { $project: { _id: 0, theaterName: "$_id", occupancyRate: 1 } },
      { $sort: { occupancyRate: -1 } },
    ]);
    res.json(data);
  } catch (e) { debug("occupancy error:", e && e.message); next(e); }
});

// 4) Bookings by hour
router.get("/bookings/by-hour", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 14);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      { $addFields: { hour: { $hour: "$createdAt" }, dow: { $dayOfWeek: "$createdAt" } } },
      { $group: { _id: { hour: "$hour", dow: "$dow" }, count: { $sum: 1 } } },
      { $project: { _id: 0, hour: "$_id.hour", dow: "$_id.dow", count: 1 } },
      { $sort: { dow: 1, hour: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("bookings/by-hour error:", e && e.message); next(e); }
});

// 5) Active users
router.get("/users/active", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", dau: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("users/active error:", e && e.message); next(e); }
});

// 6) Bookings summary
router.get("/bookings/summary", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      {
        $group: {
          _id: "$_d",
          confirmed: { $sum: { $cond: [ { $in: [ { $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"] ] }, 1, 0 ] } },
          cancelled: { $sum: { $cond: [ { $eq: [ { $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED" ] }, 1, 0 ] } },
          revenue: { $sum: { $cond: [ { $in: [ { $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"] ] }, AMOUNT_EXPR, 0 ] } },
        }
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("bookings/summary error:", e && e.message); next(e); }
});

export default router;
