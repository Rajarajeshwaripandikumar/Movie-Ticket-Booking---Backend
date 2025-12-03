// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, ROLE } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";

import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import Theater from "../models/Theater.js";
import Movie from "../models/Movie.js";

const router = Router();

/* ----------------------------- global guards ----------------------------- */

// ✅ requireAuth is a factory → CALL IT
router.use(requireAuth());
// allow both SUPER_ADMIN + theatre-scoped admin
router.use(requireRole("THEATER_ADMIN", "SUPER_ADMIN"));

/* ------------------------------ helpers ------------------------------ */

// Money: support both totalAmount and amount, default 0
const AMOUNT_EXPR = {
  $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }],
};

// Which statuses count as “successful” bookings for revenue/conversion.
const SUCCESS_STATUSES = ["PENDING", "CONFIRMED", "REFUNDED"];

// When grouping by day, we’ll just create a string "YYYY-MM-DD"
const dayProject = [
  {
    $addFields: {
      date: {
        $dateToString: { date: "$createdAt", format: "%Y-%m-%d" },
      },
    },
  },
];

/**
 * Convert "days" into a JS Date from that many days ago, at midnight.
 */
function toPast(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Resolve theater scope:
 *  - THEATRE_ADMIN: their assigned theatre (Theater.theaterAdmin = req.user.id)
 *  - SUPER_ADMIN:   ?theater or ?theaterId if valid ObjectId, else global (null)
 *
 * Return:
 *  - ObjectId|string|null => continue using this as "theaterScope"
 *  - undefined            => STOP (this function already sent a response)
 */
async function resolveTheaterScope(req, res) {
  const role = req.user?.role;

  if (role === ROLE.THEATRE_ADMIN) {
    const t = await Theater.findOne({ theaterAdmin: req.user.id }).lean();
    if (!t) {
      res.status(403).json({ message: "No theater assigned to this admin" });
      return undefined;
    }
    return t._id;
  }

  if (role === ROLE.SUPER_ADMIN) {
    const theaterParam = req.query.theater || req.query.theaterId;
    if (!theaterParam) return null; // global view

    if (!mongoose.Types.ObjectId.isValid(theaterParam)) {
      // invalid id → treat as global instead of crashing
      return null;
    }

    return theaterParam;
  }

  // any other role denied
  res.status(403).json({ message: "Forbidden" });
  return undefined;
}

/**
 * Optional movie filter (?movie=<movieId>).
 * We filter on Booking.movie (ObjectId).
 */
function buildMovieFilter(req) {
  const movieParam = req.query.movie;
  if (!movieParam) return {};
  if (!mongoose.Types.ObjectId.isValid(movieParam)) return {};
  return { movie: new mongoose.Types.ObjectId(movieParam) };
}

/**
 * Filter bookings by theatre field, based on resolved theaterScope.
 * In your DB the field is "theatre".
 */
function buildTheatreFilter(theaterScope) {
  if (!theaterScope) return {}; // global / all theatres
  return { theatre: new mongoose.Types.ObjectId(String(theaterScope)) };
}

/* =====================  /analytics/revenue/trends  ===================== */
/**
 * GET /api/analytics/revenue/trends
 * Query: ?days=30&theater=<id>&movie=<id>
 *
 * Returns array:
 *  [{ date: "YYYY-MM-DD", totalRevenue, bookings }, ...]
 */
router.get("/revenue/trends", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return; // already responded

    const theatreFilter = buildTheatreFilter(theaterScope);
    const movieFilter = buildMovieFilter(req);

    const match = {
      createdAt: { $gte: since },
      status: { $in: SUCCESS_STATUSES },
      ...theatreFilter,
      ...movieFilter,
    };

    const data = await Booking.aggregate([
      { $match: match },
      ...dayProject,
      {
        $group: {
          _id: "$date",
          totalRevenue: { $sum: AMOUNT_EXPR },
          bookings: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          totalRevenue: 1,
          bookings: 1,
        },
      },
    ]);

    res.json(data);
  } catch (err) {
    console.error("[analytics] /revenue/trends error:", err);
    next(err);
  }
});

/* =====================  /analytics/users/active  ===================== */
/**
 * GET /api/analytics/users/active
 * Query: ?days=30&theater=<id>&movie=<id>
 *
 * Returns:
 *  [{ date: "YYYY-MM-DD", dau }, ...]
 */
router.get("/users/active", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const theatreFilter = buildTheatreFilter(theaterScope);
    const movieFilter = buildMovieFilter(req);

    const match = {
      createdAt: { $gte: since },
      ...theatreFilter,
      ...movieFilter,
    };

    const data = await Booking.aggregate([
      { $match: match },
      ...dayProject,
      {
        $group: {
          _id: "$date",
          users: { $addToSet: "$user" },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          dau: { $size: "$users" },
        },
      },
      { $sort: { date: 1 } },
    ]);

    res.json(data);
  } catch (err) {
    console.error("[analytics] /users/active error:", err);
    next(err);
  }
});

/* =====================  /analytics/movies/popular  ===================== */
/**
 * GET /api/analytics/movies/popular
 * Query: ?days=30&limit=10&theater=<id>
 *
 * Returns:
 *  [{ movieId, movieName, totalBookings, totalRevenue }, ...]
 */
router.get("/movies/popular", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const theatreFilter = buildTheatreFilter(theaterScope);

    const match = {
      createdAt: { $gte: since },
      status: { $in: SUCCESS_STATUSES },
      ...theatreFilter,
    };

    const agg = await Booking.aggregate([
      { $match: match },

      // 1) Join showtimes using booking.showtime
      {
        $lookup: {
          from: "showtimes",
          localField: "showtime",
          foreignField: "_id",
          as: "showtime",
        },
      },
      { $unwind: "$showtime" },

      // 2) Join movies via showtime.movie
      {
        $lookup: {
          from: "movies",
          localField: "showtime.movie",
          foreignField: "_id",
          as: "movie",
        },
      },
      { $unwind: "$movie" },

      // 3) Group by movie
      {
        $group: {
          _id: "$movie._id",
          movieName: { $first: "$movie.title" },
          totalBookings: { $sum: 1 },
          totalRevenue: { $sum: AMOUNT_EXPR },
        },
      },

      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: 1,
          totalBookings: 1,
          totalRevenue: 1,
        },
      },
    ]);

    res.json(agg);
  } catch (err) {
    console.error("[analytics] /movies/popular error:", err);
    next(err);
  }
});

/* =====================  /analytics/occupancy  ===================== */
/**
 * GET /api/analytics/occupancy
 * Query: ?days=30&theater=<id>
 *
 * Returns:
 *  [{ theaterName, occupancyRate }, ...]
 *
 * Shows ALL theaters (0% if no shows/bookings).
 */
router.get("/occupancy", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    // If SUPER_ADMIN and no ?theater param → match all theaters
    const theaterMatch = theaterScope
      ? { _id: new mongoose.Types.ObjectId(String(theaterScope)) }
      : {};

    const data = await Theater.aggregate([
      { $match: theaterMatch },

      // For each theater, pull showtimes in range and compute seats/booked per show
      {
        $lookup: {
          from: "showtimes",
          let: { theaterId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$theater", "$$theaterId"] },
                startTime: { $gte: since },
              },
            },
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
                totalSeats: { $size: { $ifNull: ["$seats", []] } },
                booked: {
                  $sum: {
                    $map: {
                      input: "$bks",
                      as: "b",
                      in: {
                        $size: {
                          $ifNull: [
                            "$$b.seats",
                            { $ifNull: ["$$b.seatsBooked", []] },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
          as: "showStats",
        },
      },

      // Compute average occupancy across this theater's showtimes
      {
        $project: {
          theaterName: "$name",
          occupancyRate: {
            $cond: [
              { $gt: [{ $size: "$showStats" }, 0] },
              {
                $avg: {
                  $map: {
                    input: "$showStats",
                    as: "s",
                    in: {
                      $cond: [
                        { $gt: ["$$s.totalSeats", 0] },
                        { $divide: ["$$s.booked", "$$s.totalSeats"] },
                        0,
                      ],
                    },
                  },
                },
              },
              0, // no showtimes → 0% occupancy
            ],
          },
        },
      },

      { $sort: { theaterName: 1 } },
    ]);

    res.json(data);
  } catch (err) {
    console.error("[analytics] /occupancy error:", err);
    next(err);
  }
});

/* =====================  /analytics/bookings/summary  ===================== */
/**
 * GET /api/analytics/bookings/summary
 * Query: ?days=30&theater=<id>&movie=<id>
 *
 * Returns:
 *  [{ date: "YYYY-MM-DD", confirmed, cancelled, revenue }, ...]
 */
router.get("/bookings/summary", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const theaterScope = await resolveTheaterScope(req, res);
    if (theaterScope === undefined) return;

    const theatreFilter = buildTheatreFilter(theaterScope);
    const movieFilter = buildMovieFilter(req);

    const match = {
      createdAt: { $gte: since },
      ...theatreFilter,
      ...movieFilter,
    };

    const data = await Booking.aggregate([
      { $match: match },
      ...dayProject,
      {
        $group: {
          _id: "$date",
          confirmed: {
            $sum: {
              $cond: [{ $in: ["$status", SUCCESS_STATUSES] }, 1, 0],
            },
          },
          cancelled: {
            $sum: {
              $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0],
            },
          },
          revenue: {
            $sum: {
              $cond: [
                { $in: ["$status", SUCCESS_STATUSES] },
                AMOUNT_EXPR,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          confirmed: 1,
          cancelled: 1,
          revenue: 1,
        },
      },
    ]);

    res.json(data);
  } catch (err) {
    console.error("[analytics] /bookings/summary error:", err);
    next(err);
  }
});

export default router;
