// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

/**
 * Try to import explicit models if they exist in your project.
 * If not present, fall back to mongoose.models.* or create permissive schemas
 * so the route file doesn't crash in dev/test setups.
 */
function tryRequire(path) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(path).default || require(path);
  } catch (e) {
    debug(`tryRequire failed for ${path}: ${e.message}`);
    return null;
  }
}

let Booking = tryRequire("../models/Booking.js");
let Showtime = tryRequire("../models/Showtime.js");
let Theater = tryRequire("../models/Theater.js");
let Movie = tryRequire("../models/Movie.js");

// Fallbacks: if models already registered elsewhere, use those.
// If not, create permissive schemas so aggregation queries won't throw.
if (!Booking) {
  Booking = mongoose.models.Booking || mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
}
if (!Showtime) {
  Showtime = mongoose.models.Showtime || mongoose.model("Showtime", new mongoose.Schema({}, { strict: false, timestamps: true }));
}
if (!Theater) {
  Theater = mongoose.models.Theater || mongoose.model("Theater", new mongoose.Schema({}, { strict: false, timestamps: true }));
}
if (!Movie) {
  Movie = mongoose.models.Movie || mongoose.model("Movie", new mongoose.Schema({}, { strict: false, timestamps: true }));
}

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

// group-by-day using $dateTrunc if available, otherwise fallback to $dateToString
const dayProject = [
  {
    $addFields: {
      _d: {
        $cond: [
          { $function: { body: "function(){return typeof Date.prototype.toISOString === 'function'}", args: [], lang: "js" } },
          { $dateTrunc: { date: "$createdAt", unit: "day" } },
          { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        ],
      },
    },
  },
];

/* ========================  PRIMARY COMPOSITE ENDPOINT  ======================= */
/** GET /api/analytics
 * Returns aggregated analytics (revenue, users, occupancy, popularMovies)
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
      { $match: { startTime: { $gte: since } } },
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

/* ------------------------------- SSE /stream ------------------------------- */
/**
 * If you have a separate SSE handler (like backend/src/sse.js exporting sseHandler),
 * we mount it here at /stream so the frontend can open:
 *   EventSource(`${API_ROOT}/api/analytics/stream?token=...`)
 */
let sseHandler = null;
try {
  // try a common location; adjust if your file lives elsewhere
  // eslint-disable-next-line global-require, import/no-dynamic-require
  sseHandler = require("../sse.js").sseHandler || require("../sse/sse.js").sseHandler || require("../sse").sseHandler;
} catch (err) {
  debug("No sse handler found at ../sse.js or ../sse/sse.js - SSE route will return 501 until you add one.");
}

if (sseHandler && typeof sseHandler === "function") {
  router.get("/stream", sseHandler);
  debug("Mounted SSE stream at GET /api/analytics/stream");
} else {
  router.get("/stream", (req, res) => {
    res.status(501).json({
      ok: false,
      message:
        "SSE stream handler not installed on server. Create an sse.js exporting `export const sseHandler = (req, res) => { ... }` and adjust the require path in analytics.routes.js",
    });
  });
}

export default router;
