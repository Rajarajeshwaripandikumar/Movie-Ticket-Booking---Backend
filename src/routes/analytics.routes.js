import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

const Booking = mongoose.models.Booking || mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
const Showtime = mongoose.models.Showtime || mongoose.model("Showtime", new mongoose.Schema({}, { strict: false }));
const Theater = mongoose.models.Theater || mongoose.model("Theater", new mongoose.Schema({}, { strict: false }));
const Movie = mongoose.models.Movie || mongoose.model("Movie", new mongoose.Schema({}, { strict: false }));

const router = Router();

/* ----------------------------- TEMP TOKEN (dev only) ----------------------------- */
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

/* ----------------------------- HELPERS ----------------------------- */

// safe number extraction for amounts
const AMOUNT_EXPR = {
  $toDouble: { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] },
};

// tolerant references (booking shapes vary)
const SHOWTIME_REF = { $ifNull: ["$showtime", "$showtimeId", "$show", "$showId"] };
const MOVIE_REF = { $ifNull: ["$movie", "$movieId"] };
const USER_REF = { $ifNull: ["$user", "$userId"] };

const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

// normalize createdAt across string/number/date
const normalizeCreatedAtStage = [
  {
    $addFields: {
      __created_raw: { $ifNull: ["$createdAt", "$created_at", "$createdAtRaw"] }
    }
  },
  {
    $addFields: {
      createdAt: {
        $switch: {
          branches: [
            { case: { $eq: [{ $type: "$__created_raw" }, "date"] }, then: "$__created_raw" },
            { case: { $in: [{ $type: "$__created_raw" }, ["int", "long", "double", "decimal"]] }, then: { $toDate: "$__created_raw" } },
            { case: { $eq: [{ $type: "$__created_raw" }, "string"] }, then: { $dateFromString: { dateString: { $trim: { input: "$__created_raw" } }, onError: null, onNull: null } } }
          ],
          default: { $ifNull: ["$createdAt", null] }
        }
      }
    }
  },
  { $project: { __created_raw: 0 } }
];

// convert createdAt to day ISO string YYYY-MM-DD
const dayProjectSimple = [
  { $addFields: { _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } }
];

/* ----------------------------- PRIMARY COMPOSITE ENDPOINT ----------------------------- */
/**
 * GET /api/analytics
 * Returns composite object:
 * {
 *   ok: true,
 *   totals: { totalBookings, totalConfirmed, totalCancelled, totalUsers },
 *   revenue: [...],
 *   users: [...],
 *   occupancy: [...],
 *   popularMovies: [...]
 * }
 */
router.get("/", async (req, res, next) => {
  try {
    const days = Number(req.query.days || 7);
    const since = toPast(days);

    // daily revenue (confirmed/paid)
    const revenue = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProjectSimple,
      { $addFields: { __amount_safe: AMOUNT_EXPR } },
      { $group: { _id: "$_d", total: { $sum: "$__amount_safe" } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", total: 1 } }
    ]);

    // normalize revenue shape for frontend (date + value)
    const revenueForFront = (revenue || []).map(r => ({
      date: r.date || r._id || null,
      value: Number(r.total ?? 0)
    }));

    // daily active users
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { _id: 0, date: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } }
    ]);

    const usersForFront = (users || []).map(u => ({
      date: u.date || u._id || null,
      value: Number(u.count ?? u.users ?? 0)
    }));

    // totals: overall bookings + users (no date filter)
    const totalsAgg = await Booking.aggregate([
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          totalConfirmed: { $sum: { $cond: [{ $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }, 1, 0] } },
          totalCancelled: { $sum: { $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"] }, 1, 0] } },
          usersSet: { $addToSet: USER_REF }
        }
      },
      {
        $project: {
          _id: 0,
          totalBookings: 1,
          totalConfirmed: 1,
          totalCancelled: 1,
          totalUsers: { $size: "$usersSet" }
        }
      }
    ]);
    const totals = (totalsAgg && totalsAgg[0]) || { totalBookings: 0, totalConfirmed: 0, totalCancelled: 0, totalUsers: 0 };

    // theater occupancy (theater-driven). For each theater sum show capacities and confirmed bookings (within since)
    const occupancyByTheater = await Theater.aggregate([
      { $project: { name: { $ifNull: ["$name", "$title", "$displayName", "Unknown"] }, tCapacity: { $ifNull: ["$capacity", "$totalSeats", null] } } },

      // find showtimes for a theater
      {
        $lookup: {
          from: "showtimes",
          let: { tid: "$_id", tidStr: { $toString: "$_id" } },
          pipeline: [
            {
              $match: {
                $expr: { $or: [{ $eq: ["$theater", "$$tid"] }, { $eq: ["$theater", "$$tidStr"] }] }
              }
            },
            { $project: { _id: 1, capacity: 1, totalSeats: 1, seats: 1 } }
          ],
          as: "shows"
        }
      },

      // unwind shows so we can lookup bookings per show
      { $unwind: { path: "$shows", preserveNullAndEmptyArrays: true } },

      // lookup bookings for each show (confirmed/paid and within since)
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
                createdAt: { $gte: since },
                $expr: { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }
              }
            },
            { $project: { seats: 1, quantity: 1 } }
          ],
          as: "bookingsForShow"
        }
      },

      // compute booked seats for a show and show capacity
      {
        $addFields: {
          showBookedSeats: {
            $sum: {
              $map: {
                input: { $ifNull: ["$bookingsForShow", []] },
                as: "b",
                in: {
                  $cond: [
                    { $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0] },
                    { $size: { $ifNull: ["$$b.seats", []] } },
                    { $ifNull: ["$$b.quantity", 1] }
                  ]
                }
              }
            }
          },
          showCapacity: { $ifNull: ["$shows.capacity", "$shows.totalSeats", { $size: { $ifNull: ["$shows.seats", []] } }, 0] }
        }
      },

      // group back to theater level
      {
        $group: {
          _id: "$_id",
          theaterName: { $first: "$name" },
          tCapacity: { $first: "$tCapacity" },
          shows: { $push: { booked: "$showBookedSeats", capacity: "$showCapacity" } }
        }
      },

      // totals + occupancy
      {
        $addFields: {
          totalBooked: { $sum: "$shows.booked" },
          totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } }
        }
      },

      {
        $project: {
          _id: 0,
          theaterId: "$_id",
          theaterName: 1,
          totalBooked: 1,
          totalCapacity: 1,
          occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] }
        }
      },

      { $sort: { theaterName: 1 } }
    ]);

    // normalize occupancy into percent integer for frontend
    const normalizedOccupancy = (occupancyByTheater || []).map((r) => ({
      theaterId: r.theaterId,
      theaterName: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round(Number(r.occupancyRate || 0) * 100),
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0
    }));

    // popular movies (bookings + revenue)
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },

      // try to resolve showtime to get movieId if booking doesn't have movie info
      {
        $lookup: {
          from: "showtimes",
          let: { s1: { $ifNull: ["$showtime", "$showtimeId", "$show", "$showId"] } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$s1"] },
                    { $eq: [{ $toString: "$_id" }, "$$s1"] }
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

      // build movie group key (string)
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
          movieEmbeddedTitle: { $ifNull: ["$movie.title", "$movie.name", null] }
        }
      },

      { $addFields: { movieGroupKey: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] } } },

      {
        $group: {
          _id: "$movieGroupKey",
          bookings: { $sum: 1 },
          revenue: { $sum: AMOUNT_EXPR }
        }
      },

      { $sort: { bookings: -1 } },
      { $limit: 20 },

      // optional: lookup movie document to pretty name
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
                    { $eq: ["$name", "$$movieKey"] }
                  ]
                }
              }
            },
            { $project: { title: 1, name: 1 } }
          ],
          as: "movieDoc"
        }
      },
      { $unwind: { path: "$movieDoc", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: { $ifNull: ["$movieDoc.title", "$movieDoc.name", "$_id"] },
          bookings: 1,
          revenue: 1
        }
      }
    ]);

    // safer normalization & fallbacks for movie names
    const normalizedPopular = (popularMovies || []).map((m) => {
      let movieNameCandidate = (m.movieName || "").toString().trim();
      if (!movieNameCandidate || movieNameCandidate === String(m.movieId)) {
        movieNameCandidate = m.movieId ? String(m.movieId) : "Unknown";
      }

      return {
        movieId: m.movieId ?? null,
        movieName: movieNameCandidate,
        bookings: Number(m.bookings ?? m.totalBookings ?? 0),
        revenue: Number(m.revenue ?? m.totalRevenue ?? 0)
      };
    });

    res.json({
      ok: true,
      totals,
      revenue: revenueForFront,
      users: usersForFront,
      occupancy: normalizedOccupancy,
      popularMovies: normalizedPopular
    });
  } catch (err) {
    debug("analytics error:", err?.stack || err?.message);
    next(err);
  }
});

/* ----------------------------- DETAILED ENDPOINTS ----------------------------- */

// revenue trends
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
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } }
    ]);
    res.json(data);
  } catch (e) {
    debug("revenue/trends error:", e.message);
    next(e);
  }
});

// users/active
router.get("/users/active", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { date: "$_id", count: { $size: "$users" }, _id: 0 } },
      { $sort: { date: 1 } }
    ]);
    res.json(data);
  } catch (e) {
    debug("users/active error:", e.message);
    next(e);
  }
});

// occupancy (per-theater)
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
                $expr: { $or: [{ $eq: ["$theater", "$$tid"] }, { $eq: ["$theater", "$$tidStr"] }] }
              }
            },
            { $project: { _id: 1, capacity: 1, totalSeats: 1, seats: 1 } }
          ],
          as: "shows"
        }
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
                createdAt: { $gte: since },
              }
            },
            { $project: { quantity: 1, seats: 1, status: 1 } }
          ],
          as: "bookingsForShow"
        }
      },

      {
        $addFields: {
          showBookedSeats: {
            $sum: {
              $map: {
                input: { $ifNull: ["$bookingsForShow", []] },
                as: "b",
                in: {
                  $cond: [
                    { $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0] },
                    { $size: { $ifNull: ["$$b.seats", []] } },
                    { $ifNull: ["$$b.quantity", 1] }
                  ]
                }
              }
            }
          },
          showCapacity: { $ifNull: ["$shows.capacity", "$shows.totalSeats", { $size: { $ifNull: ["$shows.seats", []] } }, 0] }
        }
      },

      {
        $group: {
          _id: "$_id",
          theaterName: { $first: "$name" },
          shows: { $push: { booked: "$showBookedSeats", capacity: "$showCapacity" } }
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
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0
    }));

    res.json(out);
  } catch (e) {
    debug("occupancy error:", e.message);
    next(e);
  }
});

// popular movies (granular)
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
        $lookup: {
          from: "showtimes",
          let: { s1: { $ifNull: ["$showtime", "$showtimeId", "$show", "$showId"] } },
          pipeline: [
            {
              $match: { $expr: { $or: [{ $eq: ["$_id", "$$s1"] }, { $eq: [{ $toString: "$_id" }, "$$s1"] }] } }
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
                { case: { $eq: [{ $type: "$movie" }, "string"] }, then: "$movie" }
              ],
              default: null
            }
          },
          movieEmbeddedTitle: { $ifNull: ["$movie.title", "$movie.name", null] }
        }
      },

      { $addFields: { movieGroupKey: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] } } },

      {
        $group: {
          _id: "$movieGroupKey",
          totalBookings: { $sum: 1 },
          totalRevenue: { $sum: AMOUNT_EXPR }
        }
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
                    { $eq: ["$name", "$$mid"] }
                  ]
                }
              }
            },
            { $project: { title: 1, name: 1 } }
          ],
          as: "m"
        }
      },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: { $ifNull: ["$m.title", "$m.name", "$_id"] },
          totalBookings: 1,
          totalRevenue: 1
        }
      }
    ]);

    const out = (data || []).map((d) => ({
      movieId: d.movieId ?? null,
      movieName: d.movieName ?? (d.movieId ? String(d.movieId) : "Unknown"),
      totalBookings: Number(d.totalBookings ?? 0),
      totalRevenue: Number(d.totalRevenue ?? 0),
      bookings: Number(d.totalBookings ?? 0),
      revenue: Number(d.totalRevenue ?? 0)
    }));

    res.json(out);
  } catch (e) {
    debug("movies/popular error:", e.message);
    next(e);
  }
});

// bookings summary (daily confirmed/cancelled/revenue)
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
                { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                1,
                0
              ]
            }
          },
          cancelled: {
            $sum: {
              $cond: [
                { $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"] },
                1,
                0
              ]
            }
          },
          revenue: {
            $sum: {
              $cond: [
                { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                AMOUNT_EXPR,
                0
              ]
            }
          }
        }
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } }
    ]);
    res.json(data);
  } catch (e) {
    debug("bookings/summary error:", e.message);
    next(e);
  }
});

export default router;
