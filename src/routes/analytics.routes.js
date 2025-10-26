// backend/src/routes/analytics.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:analytics");

/* tryRequire helpers (unchanged) */
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

// Allow EventSource clients to pass token via query param (?token=...)
// by copying it into Authorization header for the /stream route only.
router.use("/stream", (req, res, next) => {
  try {
    if (!req.headers.authorization && req.query && req.query.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
  } catch (e) {
    // defensive: ignore and continue
  }
  next();
});

/* ------------------------ analytics config / helpers ---------------------- */

const TZ = process.env.ANALYTICS_TZ || "UTC";
const toPast = (days) => new Date(Date.now() - Number(days) * 864e5);

const AMOUNT_SAFE = {
  $toDouble: {
    $ifNull: ["$totalAmount", { $ifNull: ["$amount", { $ifNull: ["$price", 0] }] }],
  },
};

// Normalize createdAt: accept createdAt or created_at, and convert strings to Date
const normalizeCreatedAtStage = [
  {
    $addFields: {
      __created_raw: { $ifNull: ["$createdAt", "$created_at"] },
    },
  },
  {
    $addFields: {
      createdAt: {
        $cond: [
          { $eq: [{ $type: "$__created_raw" }, "date"] },
          "$__created_raw",
          { $toDate: "$__created_raw" },
        ],
      },
    },
  },
  { $project: { __created_raw: 0 } },
];

// dayProject still uses 'createdAt' — we'll normalize createdAt early in pipeline
const dayProject = [
  {
    $addFields: {
      _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } },
    },
  },
];

const SHOWTIME_ID = { $ifNull: ["$showtime", "$showtimeId"] };
const MOVIE_ID = { $ifNull: ["$movie", "$movieId"] };
const USER_ID = { $ifNull: ["$user", "$userId"] };
const BOOKED_SEATS_ARR = { $ifNull: ["$seats", { $ifNull: ["$seatsBooked", []] }] };

function ensureResultsForRange(startDate, endDate, rows, keyName = "date", defaults = {}) {
  const out = [];
  const cur = new Date(startDate);
  cur.setUTCHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setUTCHours(0, 0, 0, 0);
  const m = new Map(rows.map((r) => [String(r[keyName]), r]));
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    if (m.has(iso)) out.push(m.get(iso));
    else out.push({ [keyName]: iso, ...defaults });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/* ========================  PRIMARY COMPOSITE ENDPOINT  ======================= */
router.get("/", async (req, res, next) => {
  try {
    const days = Math.max(1, Number(req.query.days || 7));
    const since = toPast(days);
    const now = new Date();

    // quick count (debug) - allow createdAt OR created_at
    const totalBookingsSince = await Booking.countDocuments({
      $or: [{ createdAt: { $gte: since } }, { created_at: { $gte: since } }],
    }).catch((e) => {
      debug("countDocuments error:", e && e.message);
      return 0;
    });
    debug(`Analytics: bookings since ${since.toISOString()}: ${totalBookingsSince}`);

    /* ---------- revenue by day (normalized fields) ---------- */
    const revenue = await Booking.aggregate([
      // normalize createdAt and other common field names
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          totalAmount: { $ifNull: ["$totalAmount", "$amount", "$price", 0] },
          status: { $ifNull: ["$status", ""] },
          user: { $ifNull: ["$user", "$userId"] },
          movie: { $ifNull: ["$movie", "$movieId"] },
        },
      },
      {
        $match: {
          createdAt: { $gte: since },
          // allow status that may be lowercase by uppercasing in $expr
          $expr: {
            $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]],
          },
        },
      },
      ...dayProject,
      { $addFields: { __amount_safe: AMOUNT_SAFE } },
      {
        $group: {
          _id: "$_d",
          total: { $sum: "$__amount_safe" },
          bookings: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", total: 1, bookings: 1 } },
    ]);

    /* ---------- users (unique per day) ---------- */
    const users = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          user: { $ifNull: ["$user", "$userId"] },
        },
      },
      { $match: { createdAt: { $gte: since } } },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", dau: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);

    /* ---------- occupancy (unchanged but will work if showtime fields are consistent) ---------- */
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
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
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

    /* ---------- popular movies (normalize createdAt/status/amount fields similarly) ---------- */
    const popularMovies = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          totalAmount: { $ifNull: ["$totalAmount", "$amount", "$price", 0] },
          movie: { $ifNull: ["$movie", "$movieId"] },
          status: { $ifNull: ["$status", ""] },
        },
      },
      {
        $match: {
          createdAt: { $gte: since },
          $expr: { $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]] },
        },
      },
      {
        $group: {
          _id: MOVIE_ID,
          bookings: { $sum: 1 },
          revenue: { $sum: AMOUNT_SAFE },
        },
      },
      { $sort: { bookings: -1 } },
      { $limit: 10 },
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
                    { $eq: ["$_id", { $convert: { input: "$$mid", to: "objectId", onError: null, onNull: null } }] },
                  ],
                },
              },
            },
            { $project: { title: 1 } },
          ],
          as: "movie",
        },
      },
      { $unwind: { path: "$movie", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          movie: { $ifNull: ["$movie.title", "Unknown"] },
          bookings: 1,
          revenue: 1,
        },
      },
    ]);

    const startIso = since.toISOString().slice(0, 10);
    const endIso = now.toISOString().slice(0, 10);
    const revenueSeries = ensureResultsForRange(startIso, endIso, revenue, "date", { total: 0, bookings: 0 });
    const usersSeries = ensureResultsForRange(startIso, endIso, users, "date", { dau: 0 });

    // helpful debug: include a small sample of raw arrays (first 3 rows)
    debug("revenue sample rows:", (revenueSeries || []).slice(0, 3));
    debug("users sample rows:", (usersSeries || []).slice(0, 3));
    debug("occupancy rows:", (occupancy || []).slice(0, 5));
    debug("popularMovies rows:", (popularMovies || []).slice(0, 5));

    res.json({
      ok: true,
      revenue: revenueSeries,
      users: usersSeries,
      occupancy: occupancy || [],
      popularMovies: popularMovies || [],
      debug: { totalBookingsSince }, // keep temporarily for easy verification
    });
  } catch (err) {
    debug("Analytics error:", err && (err.stack || err.message));
    next(err);
  }
});

/* ===========================  GRANULAR ENDPOINTS  =========================== */

router.get("/revenue/trends", async (req, res, next) => {
  try {
    const days = Math.max(1, Number(req.query.days || 30));
    const since = toPast(days);
    const now = new Date();
    const raw = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          totalAmount: { $ifNull: ["$totalAmount", "$amount", "$price", 0] },
          status: { $ifNull: ["$status", ""] },
        },
      },
      {
        $match: {
          createdAt: { $gte: since },
          $expr: { $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]] },
        },
      },
      ...dayProject,
      { $addFields: { __amount_safe: AMOUNT_SAFE } },
      { $group: { _id: "$_d", totalRevenue: { $sum: "$__amount_safe" }, bookings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]);
    const data = ensureResultsForRange(since.toISOString().slice(0, 10), now.toISOString().slice(0, 10), raw, "date", {
      totalRevenue: 0,
      bookings: 0,
    });
    res.json(data);
  } catch (e) {
    debug("revenue/trends error:", e && e.message);
    next(e);
  }
});

router.get("/movies/popular", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const limit = Number(req.query.limit || 10);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          totalAmount: { $ifNull: ["$totalAmount", "$amount", "$price", 0] },
          movie: { $ifNull: ["$movie", "$movieId"] },
          status: { $ifNull: ["$status", ""] },
        },
      },
      {
        $match: {
          createdAt: { $gte: since },
          $expr: { $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]] },
        },
      },
      { $group: { _id: MOVIE_ID, totalBookings: { $sum: 1 }, totalRevenue: { $sum: AMOUNT_SAFE } } },
      { $sort: { totalBookings: -1 } },
      { $limit: limit },
      { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "m" } },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, movieId: "$_id", movieName: { $ifNull: ["$m.title", "Unknown"] }, totalBookings: 1, totalRevenue: 1 } },
    ]);
    res.json(data);
  } catch (e) {
    debug("movies/popular error:", e && e.message);
    next(e);
  }
});

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
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
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
  } catch (e) {
    debug("occupancy error:", e && e.message);
    next(e);
  }
});

router.get("/bookings/by-hour", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 14);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          status: { $ifNull: ["$status", ""] },
        },
      },
      { $match: { createdAt: { $gte: since }, $expr: { $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]] } } },
      { $addFields: { hour: { $hour: "$createdAt" }, dow: { $dayOfWeek: "$createdAt" } } },
      { $group: { _id: { hour: "$hour", dow: "$dow" }, count: { $sum: 1 } } },
      { $project: { _id: 0, hour: "$_id.hour", dow: "$_id.dow", count: 1 } },
      { $sort: { dow: 1, hour: 1 } },
    ]);
    res.json(data);
  } catch (e) {
    debug("bookings/by-hour error:", e && e.message);
    next(e);
  }
});

router.get("/users/active", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          user: { $ifNull: ["$user", "$userId"] },
        },
      },
      { $match: { createdAt: { $gte: since } } },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: USER_ID } } },
      { $project: { _id: 0, date: "$_id", dau: { $size: "$users" } } },
      { $sort: { date: 1 } },
    ]);
    const series = ensureResultsForRange(since.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10), data, "date", { dau: 0 });
    res.json(series);
  } catch (e) {
    debug("users/active error:", e && e.message);
    next(e);
  }
});

router.get("/bookings/summary", async (req, res, next) => {
  try {
    const since = toPast(req.query.days || 30);
    const data = await Booking.aggregate([
      ...normalizeCreatedAtStage,
      {
        $addFields: {
          totalAmount: { $ifNull: ["$totalAmount", "$amount", "$price", 0] },
          status: { $ifNull: ["$status", ""] },
        },
      },
      { $match: { createdAt: { $gte: since } } },
      ...dayProject,
      {
        $group: {
          _id: "$_d",
          confirmed: { $sum: { $cond: [{ $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: [{ $toUpper: "$status" }, "CANCELLED"] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $in: [{ $toUpper: "$status" }, ["CONFIRMED", "PAID"]] }, AMOUNT_SAFE, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", confirmed: 1, cancelled: 1, revenue: 1 } },
    ]);
    const series = ensureResultsForRange(since.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10), data, "date", {
      confirmed: 0,
      cancelled: 0,
      revenue: 0,
    });
    res.json(series);
  } catch (e) {
    debug("bookings/summary error:", e && e.message);
    next(e);
  }
});

/* ------------------------------- SSE /stream ------------------------------- */
let sseHandler = null;
try {
  sseHandler =
    require("../socket/sse.js").sseHandler ||
    require("../socket/sse.js").default?.sseHandler ||
    require("../sse.js").sseHandler ||
    require("../sse/sse.js").sseHandler ||
    require("../sse").sseHandler;
} catch (err) {
  debug("No sse handler found - SSE route will return 501 until you add one.");
}

if (sseHandler && typeof sseHandler === "function") {
  try {
    const sseModule =
      require("../socket/sse.js")?.default ||
      require("../socket/sse.js") ||
      require("../sse.js")?.default ||
      require("../sse.js");
    if (sseModule && typeof sseModule.ssePreflight === "function") {
      router.options("/stream", sseModule.ssePreflight);
    }
  } catch (err) {
    // ignore
  }

  router.get("/stream", sseHandler);
  debug("Mounted SSE stream at GET /api/analytics/stream");
} else {
  router.get("/stream", (req, res) => {
    debug("SSE stream requested but no handler installed.");
    res.status(501).json({
      ok: false,
      message:
        "SSE stream handler not installed on server. Create socket/sse.js exporting `export const sseHandler = (req, res) => { ... }` and adjust the require path in analytics.routes.js",
    });
  });
}

export default router;
