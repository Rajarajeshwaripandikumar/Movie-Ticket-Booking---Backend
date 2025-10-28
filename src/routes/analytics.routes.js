// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

const Booking =
  mongoose.models.Booking ||
  mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
const Showtime =
  mongoose.models.Showtime ||
  mongoose.model("Showtime", new mongoose.Schema({}, { strict: false }));
const Theater =
  mongoose.models.Theater ||
  mongoose.model("Theater", new mongoose.Schema({}, { strict: false }));
const Movie =
  mongoose.models.Movie ||
  mongoose.model("Movie", new mongoose.Schema({}, { strict: false }));

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

const AMOUNT_EXPR = {
  $toDouble: {
    $ifNull: ["$totalAmount", { $ifNull: ["$amount", { $ifNull: ["$price", 0] }] }],
  },
};

const SHOWTIME_REF = { $ifNull: ["$showtime", "$showtimeId", "$show", "$showId"] };
const MOVIE_REF = { $ifNull: ["$movie", "$movieId"] };
const USER_REF = { $ifNull: ["$user", "$userId"] };

const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

const normalizeCreatedAtStage = [
  { $addFields: { __created_raw: { $ifNull: ["$createdAt", "$created_at", "$createdAtRaw"] } } },
  {
    $addFields: {
      createdAt: {
        $switch: {
          branches: [
            { case: { $eq: [{ $type: "$__created_raw" }, "date"] }, then: "$__created_raw" },
            {
              case: { $in: [{ $type: "$__created_raw" }, ["int", "long", "double", "decimal"]] },
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

const dayProjectSimple = [
  { $addFields: { _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
];

/* ----------------------------- MAIN ANALYTICS DASHBOARD ----------------------------- */
router.get("/", async (req, res, next) => {
  try {
    const days = Number(req.query.days || 7);
    const since = toPast(days);

    /* ------------------------- REVENUE TREND ------------------------- */
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

    const revenueForFront = (revenue || []).map((r) => ({
      date: r.date || r._id || null,
      value: Number(r.total ?? 0),
    }));

    /* ------------------------- USERS DAILY ------------------------- */
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { _id: 0, date: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    const usersForFront = (users || []).map((u) => ({
      date: u.date || u._id || null,
      value: Number(u.count ?? 0),
    }));

    /* ------------------------- TOTAL COUNTS ------------------------- */
    const totalsAgg = await Booking.aggregate([
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          totalConfirmed: {
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
          totalCancelled: {
            $sum: {
              $cond: [
                {
                  $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"],
                },
                1,
                0,
              ],
            },
          },
          usersSet: { $addToSet: USER_REF },
        },
      },
      {
        $project: {
          _id: 0,
          totalBookings: 1,
          totalConfirmed: 1,
          totalCancelled: 1,
          totalUsers: { $size: "$usersSet" },
        },
      },
    ]);
    const totals =
      (totalsAgg && totalsAgg[0]) || {
        totalBookings: 0,
        totalConfirmed: 0,
        totalCancelled: 0,
        totalUsers: 0,
      };

    /* ------------------------- OCCUPANCY ------------------------- */
    const occupancyByTheater = await Theater.aggregate([
      {
        $project: {
          name: {
            $ifNull: ["$name", "$title", "$displayName", "Unknown"],
          },
          tCapacity: { $ifNull: ["$capacity", "$totalSeats", null] },
        },
      },
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
                    { $eq: ["$theater", "$$tidStr"] },
                  ],
                },
              },
            },
            { $project: { _id: 1, movie: 1, seats: 1, capacity: 1, totalSeats: 1 } },
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
                  $and: [
                    {
                      $or: [
                        { $eq: ["$showtime", "$$sid"] },
                        { $eq: ["$showtimeId", "$$sid"] },
                        { $eq: ["$show", "$$sid"] },
                      ],
                    },
                    {
                      $in: [
                        { $toUpper: { $ifNull: ["$status", ""] } },
                        ["CONFIRMED", "PAID"],
                      ],
                    },
                  ],
                },
                createdAt: { $gte: since },
              },
            },
            { $project: { seats: 1, quantity: 1 } },
          ],
          as: "bookingsForShow",
        },
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
                    {
                      $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0],
                    },
                    { $size: { $ifNull: ["$$b.seats", []] } },
                    { $ifNull: ["$$b.quantity", 1] },
                  ],
                },
              },
            },
          },
          showCapacity: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$shows.seats", []] } }, 0] },
              { $size: { $ifNull: ["$shows.seats", []] } },
              {
                $ifNull: ["$shows.capacity", { $ifNull: ["$shows.totalSeats", 0] }],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$_id",
          theaterName: { $first: "$name" },
          shows: {
            $push: { booked: "$showBookedSeats", capacity: "$showCapacity" },
          },
        },
      },
      {
        $addFields: {
          totalBooked: { $sum: "$shows.booked" },
          totalCapacity: {
            $sum: {
              $map: {
                input: "$shows",
                as: "s",
                in: { $ifNull: ["$$s.capacity", 0] },
              },
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          theaterName: 1,
          totalBooked: 1,
          totalCapacity: 1,
          occupancyRate: {
            $cond: [
              { $gt: ["$totalCapacity", 0] },
              { $divide: ["$totalBooked", "$totalCapacity"] },
              0,
            ],
          },
        },
      },
      { $sort: { theaterName: 1 } },
    ]);

    const normalizedOccupancy = (occupancyByTheater || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round(Number(r.occupancyRate || 0) * 100),
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0,
    }));

    /* ------------------------- POPULAR MOVIES ------------------------- */
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },

      // Normalize movie field
      {
        $addFields: {
          movieRef: {
            $cond: [
              { $eq: [{ $type: "$movie" }, "object"] },
              { $ifNull: ["$movie._id", "$movieId"] },
              { $ifNull: ["$movie", "$movieId"] },
            ],
          },
        },
      },

      {
        $lookup: {
          from: "showtimes",
          let: { sid: SHOWTIME_REF },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$sid"] },
                    { $eq: [{ $toString: "$_id" }, "$$sid"] },
                  ],
                },
              },
            },
            { $project: { movie: 1, title: 1 } },
          ],
          as: "showtime",
        },
      },
      { $unwind: { path: "$showtime", preserveNullAndEmptyArrays: true } },

      {
        $addFields: {
          movieKey: {
            $cond: [
              { $ne: ["$movieRef", null] },
              { $toString: "$movieRef" },
              { $ifNull: ["$showtime.movie", "$movie.title"] },
            ],
          },
          movieEmbeddedTitle: {
            $ifNull: ["$movie.title", "$movie.name", "$showtime.title", null],
          },
        },
      },

      {
        $group: {
          _id: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] },
          bookings: { $sum: 1 },
          revenue: { $sum: AMOUNT_EXPR },
        },
      },
      { $sort: { bookings: -1 } },
      { $limit: 20 },

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
          as: "movieDoc",
        },
      },
      { $unwind: { path: "$movieDoc", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movieName: {
            $ifNull: ["$movieDoc.title", "$movieDoc.name", "$_id"],
          },
          bookings: 1,
          revenue: 1,
        },
      },
    ]);

    const normalizedPopular = (popularMovies || []).map((m) => {
      let name = (m.movieName || "").toString().trim();
      if (!name || name === String(m.movieId) || name === "undefined") {
        name = "Unknown";
      }
      return {
        movieId: m.movieId,
        movieName: name,
        bookings: Number(m.bookings || 0),
        revenue: Number(m.revenue || 0),
      };
    });

    /* ------------------------- FINAL RESPONSE ------------------------- */
    res.json({
      ok: true,
      totals,
      revenue: revenueForFront,
      users: usersForFront,
      occupancy: normalizedOccupancy,
      popularMovies: normalizedPopular,
    });
  } catch (err) {
    debug("analytics error:", err?.stack || err?.message);
    next(err);
  }
});

export default router;
