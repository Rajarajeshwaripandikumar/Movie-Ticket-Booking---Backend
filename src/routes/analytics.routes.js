// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
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
router.routesPrefix = "/api/analytics";
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

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

// showtime ref can be in multiple fields
const SHOWTIME_REF = { $ifNull: ["$showtime", "$showtimeId", "$show", "$showId"] };
const MOVIE_REF = { $ifNull: ["$movie", "$movieId"] };
const USER_REF = { $ifNull: ["$user", "$userId"] };

const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

// normalize createdAt variants into createdAt: Date
const normalizeCreatedAtStage = [
  { $addFields: { __created_raw: { $ifNull: ["$createdAt", "$created_at", "$createdAtRaw"] } } },
  {
    $addFields: {
      createdAt: {
        $switch: {
          branches: [
            { case: { $eq: [{ $type: "$__created_raw" }, "date"] }, then: "$__created_raw" },
            { case: { $in: [{ $type: "$__created_raw" }, ["int", "long", "double", "decimal"]] }, then: { $toDate: "$__created_raw" } },
            { case: { $eq: [{ $type: "$__created_raw" }, "string"] }, then: { $dateFromString: { dateString: { $trim: { input: "$__created_raw" } }, onError: null, onNull: null } } },
          ],
          default: { $ifNull: ["$createdAt", null] },
        },
      },
    },
  },
  { $project: { __created_raw: 0 } },
];

// project ISO day string to _d, keep dayISO for frontend
const dayProjectSimple = [
  { $addFields: { _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
];

// extract theatreId from JWT or return null
function getTheatreIdFromReq(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded?.theatreId || null;
  } catch {
    return null;
  }
}

// build stages to filter BOOKINGS by theatre (via a lookup to showtimes)
function theatreFilterStagesForBookings(theatreId) {
  if (!theatreId) return [];
  let tidObj = null;
  try { tidObj = new mongoose.Types.ObjectId(String(theatreId)); } catch {}
  const tidStr = String(theatreId);

  return [
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
          { $project: { theater: 1 } },
        ],
        as: "__st",
      },
    },
    { $unwind: { path: "$__st", preserveNullAndEmptyArrays: true } },
    {
      $match: {
        $expr: {
          $or: [
            tidObj ? { $eq: ["$__st.theater", tidObj] } : { $eq: ["$__st.theater", null] }, // if not objectId, this branch won't match
            { $eq: [{ $toString: "$__st.theater" }, tidStr] },
          ],
        },
      },
    },
    { $project: { __st: 0 } },
  ];
}

// build stages to filter SHOWTIMES by theatre id (ObjectId or string)
function theatreFilterStagesForShowtimes(theatreId) {
  if (!theatreId) return [];
  let tidObj = null;
  try { tidObj = new mongoose.Types.ObjectId(String(theatreId)); } catch {}
  const tidStr = String(theatreId);
  return [
    {
      $match: {
        $expr: {
          $or: [
            tidObj ? { $eq: ["$theater", tidObj] } : { $eq: ["$theater", null] },
            { $eq: [{ $toString: "$theater" }, tidStr] },
          ],
        },
      },
    },
  ];
}

/* ----------------------------- MAIN ANALYTICS DASHBOARD (GLOBAL) ----------------------------- */
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
      { $project: { _id: 0, date: "$_id", dayISO: "$_id", total: 1 } },
    ]);

    const revenueForFront = (revenue || []).map((r) => ({
      date: r.date || null,
      dayISO: r.dayISO || (typeof r.date === "string" ? r.date.slice(0, 10) : null),
      value: Number(r.total ?? 0),
      total: Number(r.total ?? 0),
    }));

    /* ------------------------- USERS DAILY ------------------------- */
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { _id: 0, date: "$_id", dayISO: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    const usersForFront = (users || []).map((u) => ({
      date: u.date || null,
      dayISO: u.dayISO || (typeof u.date === "string" ? u.date.slice(0, 10) : null),
      value: Number(u.count ?? 0),
      count: Number(u.count ?? 0),
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
                { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                1, 0,
              ],
            },
          },
          totalCancelled: {
            $sum: {
              $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"] }, 1, 0],
            },
          },
          usersSet: { $addToSet: USER_REF },
        },
      },
      { $project: { _id: 0, totalBookings: 1, totalConfirmed: 1, totalCancelled: 1, totalUsers: { $size: "$usersSet" } } },
    ]);
    const totals = (totalsAgg && totalsAgg[0]) || { totalBookings: 0, totalConfirmed: 0, totalCancelled: 0, totalUsers: 0 };

    /* ------------------------- OCCUPANCY (GLOBAL) ------------------------- */
    const occupancyByTheater = await Theater.aggregate([
      { $project: { name: { $ifNull: ["$name", "$title", "$displayName", "Unknown"] }, tCapacity: { $ifNull: ["$capacity", "$totalSeats", null] } } },
      {
        $lookup: {
          from: "showtimes",
          let: { tid: "$_id", tidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$theater", "$$tid"] }, { $eq: ["$theater", "$$tidStr"] }] } } },
            { $project: { _id: 1, seats: 1, capacity: 1, totalSeats: 1 } },
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
                    { $or: [{ $eq: ["$showtime", "$$sid"] }, { $eq: ["$showtimeId", "$$sid"] }, { $eq: ["$show", "$$sid"] }] },
                    { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                  ],
                },
                createdAt: { $gte: toPast(7) }, // last 7 days to keep it light here
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
                    { $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0] },
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
              { $ifNull: ["$shows.capacity", { $ifNull: ["$shows.totalSeats", 0] }] },
            ],
          },
        },
      },
      { $group: { _id: "$_id", theaterName: { $first: "$name" }, shows: { $push: { booked: "$showBookedSeats", capacity: "$showCapacity" } } } },
      { $addFields: {
          totalBooked: { $sum: "$shows.booked" },
          totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } },
        },
      },
      { $project: { _id: 0, theaterName: 1, totalBooked: 1, totalCapacity: 1, occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] } } },
      { $sort: { theaterName: 1 } },
    ]);

    const normalizedOccupancy = (occupancyByTheater || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round(Number(r.occupancyRate || 0) * 100),
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0,
    }));

    /* ------------------------- POPULAR MOVIES (GLOBAL) ------------------------- */
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
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
            { $match: { $expr: { $or: [{ $eq: ["$_id", "$$sid"] }, { $eq: [{ $toString: "$_id" }, "$$sid"] }] } } },
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
          movieEmbeddedTitle: { $ifNull: ["$movie.title", "$movie.name", "$showtime.title", null] },
        },
      },
      { $group: { _id: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] }, bookings: { $sum: 1 }, revenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { bookings: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: "movies",
          let: { mid: "$_id" },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: [{ $toString: "$_id" }, "$$mid"] }, { $eq: ["$title", "$$mid"] }, { $eq: ["$name", "$$mid"] }] } } },
            { $project: { title: 1, name: 1 } },
          ],
          as: "movieDoc",
        },
      },
      { $unwind: { path: "$movieDoc", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$movieDoc.title", "$movieDoc.name", "$_id"] }, bookings: 1, revenue: 1 } },
    ]);

    const normalizedPopular = (popularMovies || []).map((m) => ({
      movieId: m.movieId,
      movieName: (m.movieName || "").toString().trim() || "Unknown",
      bookings: Number(m.bookings || 0),
      revenue: Number(m.revenue || 0),
    }));

    res.json({ ok: true, totals, revenue: revenueForFront, users: usersForFront, occupancy: normalizedOccupancy, popularMovies: normalizedPopular });
  } catch (err) {
    debug("analytics error:", err?.stack || err?.message);
    next(err);
  }
});

/* ----------------------------- DETAILED ENDPOINTS (GLOBAL) ----------------------------- */

// revenue trends (global)
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
      { $project: { date: "$_id", dayISO: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { debug("revenue/trends error:", e.message); next(e); }
});

// users/active (global)
router.get("/users/active", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { date: "$_id", dayISO: "$_id", count: { $size: "$users" }, _id: 0 } },
      { $sort: { date: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("users/active error:", e.message); next(e); }
});

// occupancy (per-theater, global)
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
            { $match: { $expr: { $or: [{ $eq: ["$theater", "$$tid"] }, { $eq: ["$theater", "$$tidStr"] }] } } },
            { $project: { _id: 1, seats: 1, capacity: 1, totalSeats: 1 } },
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
                    { $or: [{ $eq: ["$showtime", "$$sid"] }, { $eq: ["$showtimeId", "$$sid"] }, { $eq: ["$show", "$$sid"] }] },
                    { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                  ],
                },
                createdAt: { $gte: since },
              },
            },
            { $project: { quantity: 1, seats: 1, status: 1 } },
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
                    { $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0] },
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
              { $ifNull: ["$shows.capacity", { $ifNull: ["$shows.totalSeats", 0] }] },
            ],
          },
        },
      },
      { $group: { _id: "$_id", theaterName: { $first: "$name" }, shows: { $push: { booked: "$showBookedSeats", capacity: "$showCapacity" } } } },
      { $addFields: { totalBooked: { $sum: "$shows.booked" }, totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } } } },
      { $project: { _id: 0, theaterName: 1, totalBooked: 1, totalCapacity: 1, occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] } } },
      { $sort: { theaterName: 1 } },
    ]);

    const out = (occupancyByTheater || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round((typeof r.occupancyRate === "number" ? r.occupancyRate : 0) * 100),
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0,
    }));

    res.json(out);
  } catch (e) { debug("occupancy error:", e.message); next(e); }
});

// popular movies (global)
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
          let: { s1: SHOWTIME_REF },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$_id", "$$s1"] }, { $eq: [{ $toString: "$_id" }, "$$s1"] }] } } },
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
          movieEmbeddedTitle: { $ifNull: ["$movie.title", "$movie.name", "$showtime.title", null] },
        },
      },
      { $group: { _id: "$movieKey", totalBookings: { $sum: 1 }, totalRevenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "movies",
          let: { mid: "$_id" },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: [{ $toString: "$_id" }, "$$mid"] }, { $eq: ["$title", "$$mid"] }, { $eq: ["$name", "$$mid"] }] } } },
            { $project: { title: 1, name: 1 } },
          ],
          as: "m",
        },
      },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$m.title", "$m.name", "$_id"] }, totalBookings: 1, totalRevenue: 1 } },
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
  } catch (e) { debug("movies/popular error:", e.message); next(e); }
});

// bookings summary (global)
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
          confirmed: { $sum: { $cond: [{ $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }, AMOUNT_EXPR, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", dayISO: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("bookings/summary error:", e.message); next(e); }
});

/* ----------------------------- THEATRE-SCOPED (“MINE”) ----------------------------- */

// Main dashboard (mine)
router.get("/mine", async (req, res, next) => {
  try {
    const theatreId = getTheatreIdFromReq(req);
    if (!theatreId) return res.json({ ok: true, totals: { totalBookings: 0, totalConfirmed: 0, totalCancelled: 0, totalUsers: 0 }, revenue: [], users: [], occupancy: [], popularMovies: [] });

    const days = Number(req.query.days || 7);
    const since = toPast(days);

    // Revenue (mine)
    const revenue = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProjectSimple,
      { $addFields: { __amount_safe: AMOUNT_EXPR } },
      { $group: { _id: "$_d", total: { $sum: "$__amount_safe" } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", dayISO: "$_id", total: 1 } },
    ]);

    const revenueForFront = (revenue || []).map((r) => ({
      date: r.date || null,
      dayISO: r.dayISO || (typeof r.date === "string" ? r.date.slice(0, 10) : null),
      value: Number(r.total ?? 0),
      total: Number(r.total ?? 0),
    }));

    // Users daily (mine)
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { _id: 0, date: "$_id", dayISO: "$_id", count: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    const usersForFront = (users || []).map((u) => ({
      date: u.date || null,
      dayISO: u.dayISO || (typeof u.date === "string" ? u.date.slice(0, 10) : null),
      value: Number(u.count ?? 0),
      count: Number(u.count ?? 0),
    }));

    // Totals (mine)
    const totalsAgg = await Booking.aggregate([
      ...theatreFilterStagesForBookings(theatreId),
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          totalConfirmed: { $sum: { $cond: [{ $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }, 1, 0] } },
          totalCancelled: { $sum: { $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"] }, 1, 0] } },
          usersSet: { $addToSet: USER_REF },
        },
      },
      { $project: { _id: 0, totalBookings: 1, totalConfirmed: 1, totalCancelled: 1, totalUsers: { $size: "$usersSet" } } },
    ]);
    const totals = (totalsAgg && totalsAgg[0]) || { totalBookings: 0, totalConfirmed: 0, totalCancelled: 0, totalUsers: 0 };

    // Occupancy (just my theatre)
    let tidObj = null; try { tidObj = new mongoose.Types.ObjectId(String(theatreId)); } catch {}
    const tidStr = String(theatreId);

    const occupancyMine = await Theater.aggregate([
      {
        $match: {
          $expr: {
            $or: [
              tidObj ? { $eq: ["$_id", tidObj] } : { $eq: ["$_id", null] },
              { $eq: [{ $toString: "$_id" }, tidStr] },
            ],
          },
        },
      },
      { $project: { name: { $ifNull: ["$name", "$title", "$displayName", "Unknown"] } } },
      {
        $lookup: {
          from: "showtimes",
          let: { tid: "$_id", tidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$theater", "$$tid"] }, { $eq: ["$theater", "$$tidStr"] }] } } },
            { $project: { _id: 1, seats: 1, capacity: 1, totalSeats: 1 } },
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
                    { $or: [{ $eq: ["$showtime", "$$sid"] }, { $eq: ["$showtimeId", "$$sid"] }, { $eq: ["$show", "$$sid"] }] },
                    { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                  ],
                },
                createdAt: { $gte: toPast(7) },
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
                    { $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0] },
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
              { $ifNull: ["$shows.capacity", { $ifNull: ["$shows.totalSeats", 0] }] },
            ],
          },
        },
      },
      { $group: { _id: "$_id", theaterName: { $first: "$name" }, shows: { $push: { booked: "$showBookedSeats", capacity: "$showCapacity" } } } },
      { $addFields: {
          totalBooked: { $sum: "$shows.booked" },
          totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } },
        },
      },
      { $project: { _id: 0, theaterName: 1, totalBooked: 1, totalCapacity: 1, occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] } } },
    ]);

    const normalizedOccupancy = (occupancyMine || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round(Number(r.occupancyRate || 0) * 100),
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0,
    }));

    // Popular movies (mine)
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
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
            { $match: { $expr: { $or: [{ $eq: ["$_id", "$$sid"] }, { $eq: [{ $toString: "$_id" }, "$$sid"] }] } } },
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
          movieEmbeddedTitle: { $ifNull: ["$movie.title", "$movie.name", "$showtime.title", null] },
        },
      },
      { $group: { _id: { $ifNull: ["$movieKey", "$movieEmbeddedTitle"] }, bookings: { $sum: 1 }, revenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { bookings: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: "movies",
          let: { mid: "$_id" },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: [{ $toString: "$_id" }, "$$mid"] }, { $eq: ["$title", "$$mid"] }, { $eq: ["$name", "$$mid"] }] } } },
            { $project: { title: 1, name: 1 } },
          ],
          as: "movieDoc",
        },
      },
      { $unwind: { path: "$movieDoc", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$movieDoc.title", "$movieDoc.name", "$_id"] }, bookings: 1, revenue: 1 } },
    ]);

    const normalizedPopular = (popularMovies || []).map((m) => ({
      movieId: m.movieId,
      movieName: (m.movieName || "").toString().trim() || "Unknown",
      bookings: Number(m.bookings || 0),
      revenue: Number(m.revenue || 0),
    }));

    res.json({ ok: true, totals, revenue: revenueForFront, users: usersForFront, occupancy: normalizedOccupancy, popularMovies: normalizedPopular });
  } catch (err) {
    debug("analytics mine error:", err?.stack || err?.message);
    next(err);
  }
});

// revenue trends (mine)
router.get("/revenue/trends/mine", async (req, res, next) => {
  try {
    const theatreId = getTheatreIdFromReq(req);
    if (!theatreId) return res.json([]);
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProjectSimple,
      { $addFields: { __amount_safe: AMOUNT_EXPR } },
      { $group: { _id: "$_d", totalRevenue: { $sum: "$__amount_safe" }, bookings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", dayISO: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { debug("revenue/trends/mine error:", e.message); next(e); }
});

// users/active (mine)
router.get("/users/active/mine", async (req, res, next) => {
  try {
    const theatreId = getTheatreIdFromReq(req);
    if (!theatreId) return res.json([]);
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      { $group: { _id: "$_d", users: { $addToSet: USER_REF } } },
      { $project: { date: "$_id", dayISO: "$_id", count: { $size: "$users" }, _id: 0 } },
      { $sort: { date: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("users/active/mine error:", e.message); next(e); }
});

// occupancy (mine)
router.get("/occupancy/mine", async (req, res, next) => {
  try {
    const theatreId = getTheatreIdFromReq(req);
    if (!theatreId) return res.json([]);
    let tidObj = null; try { tidObj = new mongoose.Types.ObjectId(String(theatreId)); } catch {}
    const tidStr = String(theatreId);

    const since = toPast(req.query.days || 30);
    const occ = await Theater.aggregate([
      {
        $match: {
          $expr: {
            $or: [
              tidObj ? { $eq: ["$_id", tidObj] } : { $eq: ["$_id", null] },
              { $eq: [{ $toString: "$_id" }, tidStr] },
            ],
          },
        },
      },
      { $project: { name: { $ifNull: ["$name", "$title", "$displayName", "Unknown"] } } },
      {
        $lookup: {
          from: "showtimes",
          let: { tid: "$_id", tidStr: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$theater", "$$tid"] }, { $eq: ["$theater", "$$tidStr"] }] } } },
            { $project: { _id: 1, seats: 1, capacity: 1, totalSeats: 1 } },
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
                    { $or: [{ $eq: ["$showtime", "$$sid"] }, { $eq: ["$showtimeId", "$$sid"] }, { $eq: ["$show", "$$sid"] }] },
                    { $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] },
                  ],
                },
                createdAt: { $gte: since },
              },
            },
            { $project: { quantity: 1, seats: 1 } },
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
                    { $gt: [{ $size: { $ifNull: ["$$b.seats", []] } }, 0] },
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
              { $ifNull: ["$shows.capacity", { $ifNull: ["$shows.totalSeats", 0] }] },
            ],
          },
        },
      },
      { $group: { _id: "$_id", theaterName: { $first: "$name" }, shows: { $push: { booked: "$showBookedSeats", capacity: "$showCapacity" } } } },
      { $addFields: { totalBooked: { $sum: "$shows.booked" }, totalCapacity: { $sum: { $map: { input: "$shows", as: "s", in: { $ifNull: ["$$s.capacity", 0] } } } } } },
      { $project: { _id: 0, theaterName: 1, totalBooked: 1, totalCapacity: 1, occupancyRate: { $cond: [{ $gt: ["$totalCapacity", 0] }, { $divide: ["$totalBooked", "$totalCapacity"] }, 0] } } },
    ]);

    const out = (occ || []).map((r) => ({
      theaterName: r.theaterName || "Unknown",
      occupancyRate: typeof r.occupancyRate === "number" ? r.occupancyRate : 0,
      occupancy: Math.round((typeof r.occupancyRate === "number" ? r.occupancyRate : 0) * 100),
      totalBooked: r.totalBooked || 0,
      totalCapacity: r.totalCapacity || 0,
    }));
    res.json(out);
  } catch (e) { debug("occupancy/mine error:", e.message); next(e); }
});

// popular movies (mine)
router.get("/movies/popular/mine", async (req, res, next) => {
  try {
    const theatreId = getTheatreIdFromReq(req);
    if (!theatreId) return res.json([]);
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);

    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      { $addFields: { _statusUpper: { $toUpper: { $ifNull: ["$status", ""] } } } },
      { $match: { _statusUpper: { $in: ["CONFIRMED", "PAID"] } } },
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
          let: { s1: SHOWTIME_REF },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ["$_id", "$$s1"] }, { $eq: [{ $toString: "$_id" }, "$$s1"] }] } } },
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
          movieEmbeddedTitle: { $ifNull: ["$movie.title", "$movie.name", "$showtime.title", null] },
        },
      },
      { $group: { _id: "$movieKey", totalBookings: { $sum: 1 }, totalRevenue: { $sum: AMOUNT_EXPR } } },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "movies",
          let: { mid: "$_id" },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: [{ $toString: "$_id" }, "$$mid"] }, { $eq: ["$title", "$$mid"] }, { $eq: ["$name", "$$mid"] }] } } },
            { $project: { title: 1, name: 1 } },
          ],
          as: "m",
        },
      },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$m.title", "$m.name", "$_id"] }, totalBookings: 1, totalRevenue: 1 } },
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
  } catch (e) { debug("movies/popular/mine error:", e.message); next(e); }
});

// bookings summary (mine)
router.get("/bookings/summary/mine", async (req, res, next) => {
  try {
    const theatreId = getTheatreIdFromReq(req);
    if (!theatreId) return res.json([]);
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      ...theatreFilterStagesForBookings(theatreId),
      { $match: { createdAt: { $gte: since } } },
      ...dayProjectSimple,
      {
        $group: {
          _id: "$_d",
          confirmed: { $sum: { $cond: [{ $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "CANCELLED"] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $in: [{ $toUpper: { $ifNull: ["$status", ""] } }, ["CONFIRMED", "PAID"]] }, AMOUNT_EXPR, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", dayISO: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } },
    ]);
    res.json(data);
  } catch (e) { debug("bookings/summary/mine error:", e.message); next(e); }
});

export default router;
