// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

// Prefer explicit imports if available
const Booking  = mongoose.models.Booking  || mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
const Showtime = mongoose.models.Showtime || mongoose.model("Showtime", new mongoose.Schema({}, { strict: false }));
const Theater  = mongoose.models.Theater  || mongoose.model("Theater", new mongoose.Schema({}, { strict: false }));
const Movie    = mongoose.models.Movie    || mongoose.model("Movie", new mongoose.Schema({}, { strict: false }));

const router = Router();

/* -------------------------------------------------------------------------- */
/*                         TEMPORARY TOKEN FALLBACK                           */
/* -------------------------------------------------------------------------- */
// Allows ?token=<JWT> for analytics endpoints if Authorization header missing.
// This makes testing from browser or Netlify easier.
// ⚠️ Remove before production for better security.
router.use((req, res, next) => {
  try {
    if (!req.headers.authorization && req.query && req.query.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
  } catch (e) {
    debug("token middleware error:", e.message);
  }
  next();
});

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */

// robust amount expression (supports totalAmount or amount, coerces to double)
const AMOUNT_EXPR = {
  $toDouble: { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] },
};

// robust references
const SHOWTIME_ID = { $ifNull: ["$showtime", "$showtimeId"] };
const MOVIE_ID = { $ifNull: ["$movie", "$movieId"] };
const USER_ID = { $ifNull: ["$user", "$userId"] };

const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

// Normalize createdAt (handles string, number, or Date)
const normalizeCreatedAtStage = [
  {
    $addFields: {
      __created_raw: { $ifNull: ["$createdAt", "$created_at", "$createdAtRaw"] },
    },
  },
  {
    $addFields: {
      createdAt: {
        $switch: {
          branches: [
            {
              case: { $eq: [{ $type: "$__created_raw" }, "date"] },
              then: "$__created_raw",
            },
            {
              case: {
                $in: [
                  { $type: "$__created_raw" },
                  ["int", "long", "double", "decimal"],
                ],
              },
              then: { $toDate: "$__created_raw" },
            },
            {
              case: { $eq: [{ $type: "$__created_raw" }, "string"] },
              then: {
                $dateFromString: {
                  dateString: { $trim: { input: "$__created_raw" } },
                  onError: null,
                  onNull: null,
                },
              },
            },
          ],
          default: { $ifNull: ["$createdAt", null] },
        },
      },
    },
  },
  { $project: { __created_raw: 0 } },
];

// simple grouping by day
const dayProjectSimple = [
  { $addFields: { _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
];

/* -------------------------------------------------------------------------- */
/*                          PRIMARY COMPOSITE ENDPOINT                        */
/* -------------------------------------------------------------------------- */
/**
 * GET /api/analytics
 * Returns:
 * {
 *   ok: true,
 *   revenue: [{ date, total }],
 *   users: [{ date, count }],
 *   occupancy: [{ theaterName, name, occupancyRate, occupancy }],
 *   popularMovies: [{ movieId, movieName, movie, bookings, revenue }]
 * }
 */
router.get("/", async (req, res, next) => {
  try {
    const days = Number(req.query.days || 7);
    const since = toPast(days);

    // ---- Daily Revenue ----
    const revenue = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProjectSimple,
      { $addFields: { __amount_safe: AMOUNT_EXPR } },
      { $group: { _id: "$_d", total: { $sum: "$__amount_safe" } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", total: 1 } },
    ]);

    // ---- Daily Active Users ----
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    // ---- Theater Occupancy ----
    const occupancy = await Showtime.aggregate([
      { $match: { startTime: { $gte: since } } },
      {
        $lookup: {
          from: "bookings",
          let: { sid: "$_id", sidStr: { $toString: "$_id" } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$showtime", "$$sid"] },
                    { $eq: ["$showtime", "$$sidStr"] },
                    { $eq: ["$showtimeId", "$$sid"] },
                    { $eq: ["$showtimeId", "$$sidStr"] },
                  ],
                },
              },
            },
            { $project: { seats: 1, seatsBooked: 1, quantity: 1, createdAt: 1 } },
          ],
          as: "bks",
        },
      },
      { $lookup: { from: "theaters", localField: "theater", foreignField: "_id", as: "t" } },
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          theater: { $ifNull: ["$t.name", "$t.title", "$t.displayName", "$t.label", null] },
          totalSeats: { $size: { $ifNull: ["$seats", []] } },
          showtimeCapacity: { $ifNull: ["$capacity", "$totalSeats", null] },
          theaterCapacity: { $ifNull: ["$t.capacity", "$t.totalSeats", null] },
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
                      qtyNum: { $ifNull: ["$$b.quantity", null] },
                    },
                    in: {
                      $cond: [
                        { $gt: ["$$seatsArraySize", 0] },
                        "$$seatsArraySize",
                        {
                          $cond: [
                            { $ne: ["$$seatsBookedNum", null] },
                            "$$seatsBookedNum",
                            {
                              $cond: [{ $ne: ["$$qtyNum", null] }, "$$qtyNum", 1],
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          // derive a totalSeats fallback (prefer explicit seats array, then showtimeCapacity, then theaterCapacity)
          totalSeats: {
            $cond: [
              { $gt: ["$totalSeats", 0] },
              "$totalSeats",
              { $ifNull: ["$showtimeCapacity", { $ifNull: ["$theaterCapacity", 0] }] },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$theater",
          // average across showtimes
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

    // ---- Popular Movies ----
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
      { $limit: 20 },
      // try to resolve movie document if available
      {
        $lookup: {
          from: "movies",
          let: { mid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$mid"] },
                    { $eq: [{ $toString: "$_id" }, "$$mid"] },
                  ],
                },
              },
            },
            { $project: { title: 1, name: 1 } },
          ],
          as: "movieDoc",
        },
      },
      { $unwind: { path: "$movieDoc", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: { $ifNull: ["$movieDoc.title", "$movieDoc.name", null] },
          // keep 'movie' for older frontend shapes
          movie: { $ifNull: ["$movieDoc.title", "$movieDoc.name", null] },
          bookings: 1,
          revenue: 1,
        },
      },
    ]);

    /* ------------------ Normalization for frontend ------------------ */
    // Normalize occupancy shape to expected keys (the frontend may expect 'name' or 'theaterName', and 'occupancy' as percent)
    const normalizedOccupancy = (occupancy || []).map((r) => {
      const occupancyRate = typeof r.occupancyRate === "number" ? r.occupancyRate : 0;
      return {
        theaterName: r.theaterName || r.name || "Unknown",
        name: r.theaterName || r.name || "Unknown",
        occupancyRate,
        occupancy: Math.round(Number(occupancyRate || 0) * 100), // percent
      };
    });

    // Normalize popularMovies to include movieName/movie and numeric fields the frontend expects
    const normalizedPopular = (popularMovies || []).map((m) => ({
      movieId: m.movieId ?? null,
      movieName: m.movieName ?? m.movie ?? (m.movieId ? String(m.movieId) : "Unknown"),
      movie: m.movieName ?? m.movie ?? (m.movieId ? String(m.movieId) : "Unknown"),
      bookings: Number(m.bookings ?? 0),
      revenue: Number(m.revenue ?? 0),
      totalBookings: Number(m.bookings ?? 0),
      totalRevenue: Number(m.revenue ?? 0),
    }));

    res.json({
      ok: true,
      revenue,
      users,
      occupancy: normalizedOccupancy,
      popularMovies: normalizedPopular,
    });
  } catch (err) {
    debug("analytics error:", err?.stack || err?.message);
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/*                            GRANULAR ENDPOINTS                              */
/* -------------------------------------------------------------------------- */

// 1. Revenue trends
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
      {
        $group: {
          _id: "$_d",
          totalRevenue: { $sum: "$__amount_safe" },
          bookings: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) {
    debug("revenue/trends error:", e.message);
    next(e);
  }
});

// 2. Popular movies
router.get("/movies/popular", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      {
        $group: {
          _id: MOVIE_ID,
          totalBookings: { $sum: 1 },
          totalRevenue: { $sum: AMOUNT_EXPR },
        },
      },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "movies",
          let: { mid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$mid"] },
                    { $eq: [{ $toString: "$_id" }, "$$mid"] },
                  ],
                },
              },
            },
            { $project: { title: 1, name: 1 } },
          ],
          as: "m",
        },
      },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: { $ifNull: ["$m.title", "$m.name", null] },
          movie: { $ifNull: ["$m.title", "$m.name", null] },
          totalBookings: 1,
          totalRevenue: 1,
        },
      },
    ]);

    // Normalize to frontend-friendly shape (include movieName fallback)
    const out = (data || []).map((d) => ({
      movieId: d.movieId ?? null,
      movieName: d.movieName ?? d.movie ?? (d.movieId ? String(d.movieId) : "Unknown"),
      totalBookings: Number(d.totalBookings ?? 0),
      totalRevenue: Number(d.totalRevenue ?? 0),
      bookings: Number(d.totalBookings ?? 0),
      revenue: Number(d.totalRevenue ?? 0),
    }));

    res.json(out);
  } catch (e) {
    debug("movies/popular error:", e.message);
    next(e);
  }
});

// 3. Theater occupancy
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
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$showtime", "$$sid"] },
                    { $eq: ["$showtime", "$$sidStr"] },
                    { $eq: ["$showtimeId", "$$sid"] },
                    { $eq: ["$showtimeId", "$$sidStr"] },
                  ],
                },
                createdAt: { $gte: since },
              },
            },
            { $project: { seats: 1, seatsBooked: 1, quantity: 1 } },
          ],
          as: "bks",
        },
      },
      {
        $project: {
          theater: 1,
          totalSeats: { $size: { $ifNull: ["$seats", []] } },
          showtimeCapacity: { $ifNull: ["$capacity", "$totalSeats", null] },
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
                      qtyNum: { $ifNull: ["$$b.quantity", null] },
                    },
                    in: {
                      $cond: [
                        { $gt: ["$$seatsArraySize", 0] },
                        "$$seatsArraySize",
                        {
                          $cond: [
                            { $ne: ["$$seatsBookedNum", null] },
                            "$$seatsBookedNum",
                            { $cond: [{ $ne: ["$$qtyNum", null] }, "$$qtyNum", 1] },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      { $lookup: { from: "theaters", localField: "theater", foreignField: "_id", as: "t" } },
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          totalSeats: {
            $cond: [
              { $gt: ["$totalSeats", 0] },
              "$totalSeats",
              { $ifNull: ["$showtimeCapacity", { $ifNull: ["$t.capacity", 0] }] },
            ],
          },
        },
      },
      {
        $group: {
          _id: { name: { $ifNull: ["$t.name", "$t.title", "$t.displayName", "Unknown"] } },
          occupancyRate: {
            $avg: {
              $cond: [{ $gt: ["$totalSeats", 0] }, { $divide: ["$booked", "$totalSeats"] }, 0],
            },
          },
        },
      },
      { $project: { _id: 0, theaterName: "$_id.name", occupancyRate: 1 } },
      { $sort: { occupancyRate: -1 } },
    ]);

    // Add percent occupancy to each row for easier frontend use
    const out = (data || []).map((r) => ({
      theaterName: r.theaterName || r.name || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round((typeof r.occupancyRate === "number" ? r.occupancyRate : 0) * 100),
    }));

    res.json(out);
  } catch (e) {
    debug("occupancy error:", e.message);
    next(e);
  }
});

// 4. Active users
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
  } catch (e) {
    debug("users/active error:", e.message);
    next(e);
  }
});

// 5. Bookings summary
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
          confirmed: {
            $sum: {
              $cond: [
                {
                  $in: [
                    { $toUpper: { $ifNull: ["$status", ""] } },
                    ["CONFIRMED", "PAID"],
                  ],
                },
                1,
                0,
              ],
            },
          },
          cancelled: {
            $sum: {
              $cond: [
                {
                  $eq: [
                    { $toUpper: { $ifNull: ["$status", ""] } },
                    "CANCELLED",
                  ],
                },
                1,
                0,
              ],
            },
          },
          revenue: {
            $sum: {
              $cond: [
                {
                  $in: [
                    { $toUpper: { $ifNull: ["$status", ""] } },
                    ["CONFIRMED", "PAID"],
                  ],
                },
                AMOUNT_EXPR,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } },
    ]);
    res.json(data);
  } catch (e) {
    debug("bookings/summary error:", e.message);
    next(e);
  }
});

export default router;
