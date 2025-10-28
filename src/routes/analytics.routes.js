// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

// Prefer explicit imports if available
const Booking = mongoose.models.Booking || mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
const Showtime = mongoose.models.Showtime || mongoose.model("Showtime", new mongoose.Schema({}, { strict: false }));
const Theater = mongoose.models.Theater || mongoose.model("Theater", new mongoose.Schema({}, { strict: false }));
const Movie = mongoose.models.Movie || mongoose.model("Movie", new mongoose.Schema({}, { strict: false }));

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

    // ---- Theater Occupancy (theater-driven: returns all theaters) ----
    const occupancyByTheater = await Theater.aggregate([
      // normalize theater name + any theater-level capacity
      { $project: { name: { $ifNull: ["$name", "$title", "$displayName", "Unknown"] }, tCapacity: { $ifNull: ["$capacity", "$totalSeats", null] } } },

      // lookup showtimes for the theater
      {
        $lookup: {
          from: "showtimes",
          let: { tid: "$_id", tidStr: { $toString: "$_id" } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$theater", "$$tid"] },
                    { $eq: ["$theater", "$$tidStr"] }
                  ]
                }
              }
            },
            { $project: { _id: 1, seats: 1, capacity: 1, totalSeats: 1 } }
          ],
          as: "shows",
        },
      },

      // unwind shows (preserve theaters with no shows)
      { $unwind: { path: "$shows", preserveNullAndEmptyArrays: true } },

      // lookup bookings for each show (bookings within 'since' window)
      {
        $lookup: {
          from: "bookings",
          let: { sid: "$shows._id", sidStr: { $toString: "$shows._id" } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$showtime", "$$sid"] },
                    { $eq: ["$showtime", "$$sidStr"] },
                    { $eq: ["$showtimeId", "$$sid"] },
                    { $eq: ["$showtimeId", "$$sidStr"] },
                    { $eq: ["$show", "$$sid"] },
                    { $eq: ["$show", "$$sidStr"] }
                  ]
                },
                createdAt: { $gte: since }
              }
            },
            { $project: { quantity: 1 } }
          ],
          as: "bookingsForShow",
        },
      },

      // compute bookedSeats and showCapacity for this show
      {
        $addFields: {
          "showBookings.bookedSeats": { $sum: { $map: { input: { $ifNull: ["$bookingsForShow", []] }, as: "b", in: { $ifNull: ["$$b.quantity", 1] } } } },
          "showBookings.showCapacity": { $ifNull: ["$shows.capacity", "$shows.totalSeats", { $size: { $ifNull: ["$shows.seats", []] } } ] }
        }
      },

      // group back to theater
      {
        $group: {
          _id: "$_id",
          theaterName: { $first: "$name" },
          tCapacity: { $first: "$tCapacity" },
          shows: { $push: { booked: "$showBookings.bookedSeats", capacity: "$showBookings.showCapacity" } }
        }
      },

      // compute totals and occupancy (ignore shows with null capacity)
      {
        $addFields: {
          totalBooked: { $sum: "$shows.booked" },
          totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } }
        }
      },

      // derive occupancy %, fallback to 0 when capacity is zero or missing
      {
        $project: {
          _id: 0,
          theaterName: 1,
          totalBooked: 1,
          totalCapacity: 1,
          occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] }
        }
      },

      // sort for UI
      { $sort: { theaterName: 1 } }
    ]);

    const normalizedOccupancy = (occupancyByTheater || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
      name: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round(Number(r.occupancyRate || 0) * 100),
    }));

    // ---- Popular Movies (robust: tries many booking/showtime shapes) ----
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },

      // Lookup showtime by trying multiple possible booking fields (objectId or string)
      {
        $lookup: {
          from: "showtimes",
          let: {
            s1: { $ifNull: ["$showtime", "$showtimeId"] },
            s2: { $ifNull: ["$show", "$showId"] },
            s3: { $ifNull: ["$screen", "$screenId"] },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$s1"] },
                    { $eq: [{ $toString: "$_id" }, "$$s1"] },
                    { $eq: ["$_id", "$$s2"] },
                    { $eq: [{ $toString: "$_id" }, "$$s2"] },
                    { $eq: ["$_id", "$$s3"] },
                    { $eq: [{ $toString: "$_id" }, "$$s3"] }
                  ]
                }
              }
            },
            { $project: { movieId: 1, title: 1, seats: 1, capacity: 1, totalSeats: 1 } }
          ],
          as: "showtime"
        }
      },
      { $unwind: { path: "$showtime", preserveNullAndEmptyArrays: true } },

      // Build a robust movie key: booking.movie._id, booking.movie (objectId), booking.movieId, showtime.movieId, or string
      {
        $addFields: {
          movieKey: {
            $switch: {
              branches: [
                { case: { $and: [{ $ne: ["$movie._id", null] }] }, then: { $toString: "$movie._id" } },
                { case: { $eq: [{ $type: "$movie" }, "objectId"] }, then: { $toString: "$movie" } },
                { case: { $ne: ["$movieId", null] }, then: { $toString: "$movieId" } },
                { case: { $ne: ["$showtime.movieId", null] }, then: { $toString: "$showtime.movieId" } },
                { case: { $eq: [{ $type: "$movie" }, "string"] }, then: "$movie" }
              ],
              default: null
            }
          },
          movieEmbeddedTitle: { $ifNull: ["$movie.title", { $ifNull: ["$movie.name", null] }] }
        }
      },

      { $addFields: { movieGroupKey: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] } } },

      // group by movieGroupKey (either id-string or title)
      {
        $group: {
          _id: "$movieGroupKey",
          bookings: { $sum: 1 },
          revenue: { $sum: AMOUNT_EXPR },
        }
      },

      { $sort: { bookings: -1 } },
      { $limit: 20 },

      // Lookup movie document by id (as string) OR by title/name matching the group key
      {
        $lookup: {
          from: "movies",
          let: { movieKey: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$movieKey"] },
                    { $eq: ["$title", "$$movieKey"] },
                    { $eq: ["$name", "$$movieKey"] },
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

      // Provide movieName using best available source (movieDoc.title, movieDoc.name, or the group key)
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: { $ifNull: ["$movieDoc.title", "$movieDoc.name", "$_id"] },
          bookings: 1,
          revenue: 1,
        },
      },
    ]);

    // Normalize popularMovies to include movieName/movie and numeric fields the frontend expects
    const normalizedPopular = (popularMovies || []).map((m) => ({
      movieId: m.movieId ?? null,
      movieName: m.movieName ?? (m.movieId ? String(m.movieId) : "Unknown"),
      movie: m.movieName ?? (m.movieId ? String(m.movieId) : "Unknown"),
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

// 2. Popular movies (granular)
router.get("/movies/popular", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);

    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },

      // lookup showtime using multiple possible fields
      {
        $lookup: {
          from: "showtimes",
          let: {
            s1: { $ifNull: ["$showtime", "$showtimeId"] },
            s2: { $ifNull: ["$show", "$showId"] },
            s3: { $ifNull: ["$screen", "$screenId"] },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$s1"] },
                    { $eq: [{ $toString: "$_id" }, "$$s1"] },
                    { $eq: ["$_id", "$$s2"] },
                    { $eq: [{ $toString: "$_id" }, "$$s2"] },
                    { $eq: ["$_id", "$$s3"] },
                    { $eq: [{ $toString: "$_id" }, "$$s3"] }
                  ]
                }
              }
            },
            { $project: { movieId: 1, title: 1 } }
          ],
          as: "showtime"
        }
      },
      { $unwind: { path: "$showtime", preserveNullAndEmptyArrays: true } },

      {
        $addFields: {
          movieKey: {
            $switch: {
              branches: [
                { case: { $and: [{ $ne: ["$movie._id", null] }] }, then: { $toString: "$movie._id" } },
                { case: { $eq: [{ $type: "$movie" }, "objectId"] }, then: { $toString: "$movie" } },
                { case: { $ne: ["$movieId", null] }, then: { $toString: "$movieId" } },
                { case: { $ne: ["$showtime.movieId", null] }, then: { $toString: "$showtime.movieId" } },
                { case: { $eq: [{ $type: "$movie" }, "string"] }, then: "$movie" },
              ],
              default: null,
            },
          },
          movieEmbeddedTitle: { $ifNull: ["$movie.title", { $ifNull: ["$movie.name", null] }] },
        },
      },

      { $addFields: { movieGroupKey: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] } } },

      {
        $group: {
          _id: "$movieGroupKey",
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
                    { $eq: [{ $toString: "$_id" }, "$$mid"] },
                    { $eq: ["$title", "$$mid"] },
                    { $eq: ["$name", "$$mid"] },
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
          movieName: { $ifNull: ["$m.title", "$m.name", "$_id"] },
          totalBookings: 1,
          totalRevenue: 1,
        },
      },
    ]);

    const out = (data || []).map((d) => ({
      movieId: d.movieId ?? null,
      movieName: d.movieName ?? (d.movieId ? String(d.movieId) : "Unknown"),
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

// 3. Theater occupancy (granular) — mirror of theater-driven occupancy used above
router.get("/occupancy", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);

    const occupancyByTheater = await Theater.aggregate([
      { $project: { name: { $ifNull: ["$name", "$title", "$displayName", "Unknown"] }, tCapacity: { $ifNull: ["$capacity", "$totalSeats", null] } } },

      {
        $lookup: {
          from: "showtimes",
          let: { tid: "$_id", tidStr: { $toString: "$_id" } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$theater", "$$tid"] },
                    { $eq: ["$theater", "$$tidStr"] }
                  ]
                }
              }
            },
            { $project: { _id: 1, seats: 1, capacity: 1, totalSeats: 1 } }
          ],
          as: "shows",
        },
      },

      { $unwind: { path: "$shows", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "bookings",
          let: { sid: "$shows._id", sidStr: { $toString: "$shows._id" } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$showtime", "$$sid"] },
                    { $eq: ["$showtime", "$$sidStr"] },
                    { $eq: ["$showtimeId", "$$sid"] },
                    { $eq: ["$showtimeId", "$$sidStr"] },
                    { $eq: ["$show", "$$sid"] },
                    { $eq: ["$show", "$$sidStr"] }
                  ]
                },
                createdAt: { $gte: since }
              }
            },
            { $project: { quantity: 1 } }
          ],
          as: "bookingsForShow",
        },
      },

      {
        $addFields: {
          "showBookings.bookedSeats": { $sum: { $map: { input: { $ifNull: ["$bookingsForShow", []] }, as: "b", in: { $ifNull: ["$$b.quantity", 1] } } } },
          "showBookings.showCapacity": { $ifNull: ["$shows.capacity", "$shows.totalSeats", { $size: { $ifNull: ["$shows.seats", []] } } ] }
        }
      },

      {
        $group: {
          _id: "$_id",
          theaterName: { $first: "$name" },
          tCapacity: { $first: "$tCapacity" },
          shows: { $push: { booked: "$showBookings.bookedSeats", capacity: "$showBookings.showCapacity" } }
        }
      },

      {
        $addFields: {
          totalBooked: { $sum: "$shows.booked" },
          totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } }
        }
      },

      {
        $project: {
          _id: 0,
          theaterName: 1,
          totalBooked: 1,
          totalCapacity: 1,
          occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] }
        }
      },

      { $sort: { theaterName: 1 } }
    ]);

    const out = (occupancyByTheater || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
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
