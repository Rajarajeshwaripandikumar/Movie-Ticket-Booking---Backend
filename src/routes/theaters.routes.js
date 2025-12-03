// backend/src/routes/theaters.routes.js — FULL UPDATED VERSION
// - Fixed typo (thater -> theater)
// - Kept requireAuth() usage
// - Reused shared handlers for admin + aliases
// - ScreenCounts aggregation supports both theatreId and theater fields
// - Added /movies route for theatre admins (used by /theatre/showtimes)
// - Added /reports + /reports/summary route for theatre admins (used by /theatre/reports + TheatreDashboard)
// - /reports now ALSO returns bookings[] with populated user + showtime and pagination

import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import Movie from "../models/Movie.js"; // used for /movies route
import Booking from "../models/Booking.js"; // used for /reports route
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  requireScopedTheatre,
  assertInScopeOrThrow,
  isSuperOrOwner,
  getTheatreId,
} from "../middleware/scope.js";

dotenv.config();
const router = express.Router();

/** NOTE: app.js should mount this router under /api/theaters
 *  (and optionally also under /api/theatre for compatibility)
 *
 *  app.use("/api/theaters", theatersRouter);
 *  app.use("/api/theatre", theatersRouter); // <-- for /api/theatre/my, /api/theatre/movies, /api/theatre/reports, etc.
 */
router.routesPrefix = "/api/theaters";

/* ----------------------------- Cloudinary ------------------------------ */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const CLOUDINARY_CONFIGURED =
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

/* ----------------------------- Multer --------------------------------- */
const memoryStorage = multer.memoryStorage();
const fileFilter = (_req, file, cb) => {
  const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"].includes(
    file.mimetype
  );
  ok ? cb(null, true) : cb(new Error("Only image files are allowed"));
};

const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadToCloudinary = (buffer, folder = "theaters") =>
  new Promise((resolve, reject) => {
    if (!CLOUDINARY_CONFIGURED) return reject(new Error("Cloudinary not configured"));
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", use_filename: true, unique_filename: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });

/* ----------------------------- Utils ---------------------------------- */
const isValidId = (id) => mongoose.isValidObjectId(id);

const toArray = (input) => {
  if (!input && input !== 0) return [];
  if (Array.isArray(input))
    return input
      .map((v) => String(v).trim())
      .filter(Boolean);

  const s = String(input).trim();
  if (!s) return [];

  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed))
        return parsed
          .map((v) => String(v).trim())
          .filter(Boolean);
    } catch {
      // ignore JSON parse errors
    }
  }

  return s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
};

const sanitizePayload = (raw = {}) => {
  const payload = { ...raw };
  delete payload.nameLower;
  delete payload.cityLower;
  delete payload.__v;
  delete payload._id;
  return payload;
};

/* =========================================================================
   SHARED HANDLERS (used by aliases)
   ========================================================================= */

/**
 * Build payload from existing + req.body + optional new image
 */
const buildTheaterPayloadFromRequest = async (existingDoc, req) => {
  let base = existingDoc ? existingDoc.toObject() : {};
  let payload = { ...base, ...sanitizePayload(req.body || {}) };

  payload.amenities = toArray(payload.amenities);

  // handle image if present
  if (req.file) {
    if (!CLOUDINARY_CONFIGURED) {
      const err = new Error("Image uploads are not configured on the server");
      err.status = 500;
      throw err;
    }

    if (existingDoc?.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(existingDoc.imagePublicId);
      } catch (e) {
        console.warn("[Cloudinary] delete old:", e.message);
      }
    }

    const folder = process.env.CLOUDINARY_FOLDER || "theaters";
    const result = await uploadToCloudinary(req.file.buffer, folder);
    payload.imageUrl = result.secure_url;
    payload.imagePublicId = result.public_id;
  }

  if (!Array.isArray(payload.amenities)) payload.amenities = [];

  // attach uploader for new docs
  if (!existingDoc && req.user) {
    payload.uploaderId = req.user.id || req.user._id;
    payload.uploaderRole = req.user.role || "admin";
  }

  return payload;
};

/**
 * Create theater (used by POST /admin and POST /admin/theaters)
 */
const createTheaterHandler = async (req, res) => {
  if (!isSuperOrOwner(req.user)) {
    return res
      .status(403)
      .json({ message: "You are not allowed to create new theaters" });
  }

  const payload = await buildTheaterPayloadFromRequest(null, req);
  const created = await Theater.create(payload);
  return res.status(201).json({ ok: true, data: created });
};

/**
 * Update theater (used by PUT /admin/:id and /admin/theaters/:id)
 */
const updateTheaterHandler = async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

  const existing = await Theater.findById(id);
  if (!existing) return res.status(404).json({ message: "Theater not found" });

  assertInScopeOrThrow(existing._id, req);

  const payload = await buildTheaterPayloadFromRequest(existing, req);

  const updated = await Theater.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true,
  }).lean();

  return res.json({ ok: true, data: updated });
};

/**
 * Update amenities (used by PATCH /admin/:id/amenities and /admin/theaters/:id/amenities)
 */
const updateAmenitiesHandler = async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

  const existing = await Theater.findById(id).lean();
  if (!existing) return res.status(404).json({ message: "Theater not found" });

  assertInScopeOrThrow(existing._id, req);

  const amenities = toArray(req.body?.amenities ?? req.body);
  const updated = await Theater.findByIdAndUpdate(
    id,
    { $set: { amenities } },
    { new: true, runValidators: true }
  ).lean();

  if (!updated) return res.status(404).json({ message: "Theater not found" });

  return res.json({ ok: true, data: updated });
};

/**
 * Delete theater (used by DELETE /admin/:id and /admin/theaters/:id)
 */
const deleteTheaterHandler = async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater ID" });

  const existing = await Theater.findById(id);
  if (!existing) return res.status(404).json({ message: "Theater not found" });

  assertInScopeOrThrow(existing._id, req);

  const deleted = await Theater.findByIdAndDelete(id);
  if (!deleted) return res.status(404).json({ message: "Theater not found" });

  if (deleted.imagePublicId) {
    try {
      await cloudinary.uploader.destroy(deleted.imagePublicId);
    } catch (err) {
      console.warn("[Cloudinary] Failed to delete theater poster:", err.message);
    }
  }

  return res.json({ ok: true, message: "Deleted", id });
};

/* =========================================================================
   THEATRE ADMIN (self-scoped)
   ========================================================================= */

/** GET /api/theaters/me  */
router.get("/me", requireAuth(), async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const theater = await Theater.findById(theatreId).lean();
    if (!theater) return res.status(404).json({ message: "Theatre not found" });

    const screensCount = await Screen.countDocuments({
      $or: [{ theatreId }, { theater: new mongoose.Types.ObjectId(theatreId) }],
    });

    return res.json({ ...theater, screensCount });
  } catch (err) {
    console.error("[Theaters] GET /me error:", err);
    return res.status(500).json({ message: "Failed to fetch theatre" });
  }
});

/** Alias: GET /api/theaters/my (so /api/theatre/my also works if router is double-mounted) */
router.get("/my", requireAuth(), async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const theater = await Theater.findById(theatreId).lean();
    if (!theater) return res.status(404).json({ message: "Theatre not found" });

    const screensCount = await Screen.countDocuments({
      $or: [{ theatreId }, { theater: new mongoose.Types.ObjectId(theatreId) }],
    });

    return res.json({ ...theater, screensCount });
  } catch (err) {
    console.error("[Theaters] GET /my error:", err);
    return res.status(500).json({ message: "Failed to fetch theatre" });
  }
});

/** GET /api/theaters/me/screens */
router.get("/me/screens", requireAuth(), async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const screens = await Screen.find({
      $or: [{ theatreId }, { theater: theatreId }],
    }).lean();

    return res.json({ data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /me/screens error:", err);
    return res.status(500).json({ message: "Failed to load screens" });
  }
});

/** GET /api/theaters/movies  (and /api/theatre/movies via double mount)
 *  Used by theatre CreateShowtime page "Select movie" dropdown.
 */
router.get("/movies", requireAuth(), async (req, res) => {
  try {
    // you can use this later if you want per-theatre filtering
    const theatreId = req.user?.theatreId;

    // SIMPLE VERSION: return all movies so dropdown is not empty
    const movies = await Movie.find({})
      .select("_id title language runtime certification posterUrl genres")
      .sort({ title: 1 })
      .lean();

    // If you add theatres field on Movie:
    // const movies = await Movie.find({ theatres: theatreId }).sort({ title: 1 }).lean();

    return res.json({ data: movies });
  } catch (err) {
    console.error("[Theaters] GET /movies error:", err);
    return res.status(500).json({ message: "Failed to load movies" });
  }
});

/** GET /api/theaters/me/summary */
router.get("/me/summary", requireAuth(), async (req, res) => {
  try {
    const theatreId = req.user?.theatreId;
    if (!theatreId) return res.status(404).json({ message: "Theatre not found" });

    const [theater, screensCount] = await Promise.all([
      Theater.findById(theatreId).select("name city updatedAt").lean(),
      Screen.countDocuments({ $or: [{ theatreId }, { theater: theatreId }] }),
    ]);
    if (!theater) return res.status(404).json({ message: "Theatre not found" });

    return res.json({
      name: theater.name,
      city: theater.city,
      screensCount,
      updatedAt: theater.updatedAt,
    });
  } catch (err) {
    console.error("[Theaters] GET /me/summary error:", err);
    return res.status(500).json({ message: "Failed to load summary" });
  }
});

/* =========================================================================
   SHARED THEATRE REPORTS PIPELINE (for /reports + /reports/summary)
   ========================================================================= */

const buildTheatreReportsPipeline = ({ theatreId, startDate, endDate }) => {
  const theatreObjectId = new mongoose.Types.ObjectId(theatreId);

  const baseMatch = {
    status: "CONFIRMED",
    createdAt: { $gte: startDate, $lte: endDate },
  };

  // NOTE: we now robustly match bookings by either a theatre reference on the showtime
  // OR by the showtime -> screen -> theatre relationship. This covers both schemas
  // where showtime stores theatreId directly, or where showtime only has screenId.
  const lookupAndFilter = [
    { $match: baseMatch },
    {
      $lookup: {
        from: "showtimes", // Showtime model => "showtimes" collection
        localField: "showtime",
        foreignField: "_id",
        as: "showtime",
      },
    },
    { $unwind: "$showtime" },

    // lookup screen so we can match theatre via screen.theatreId if showtime doesn't store theatreId
    {
      $lookup: {
        from: "screens",
        localField: "showtime.screenId",
        foreignField: "_id",
        as: "screen",
      },
    },
    { $unwind: { path: "$screen", preserveNullAndEmptyArrays: true } },

    {
      $match: {
        $or: [
          { "showtime.theatreId": theatreObjectId },
          { "showtime.theater": theatreObjectId },
          { "showtime.theatre": theatreObjectId },
          { "screen.theatreId": theatreObjectId },
          { "screen.theater": theatreObjectId }
        ],
      },
    },
  ];

  return { baseMatch, lookupAndFilter };
};

/** GET /api/theaters/reports
 *  (and /api/theatre/reports via double mount)
 *  Used by TheatreReports page for THEATRE_ADMIN.
 *  Returns stats, charts, AND bookings[] for table (with user + showtime).
 */
router.get("/reports", requireAuth(), async (req, res) => {
  try {
    const { start, end } = req.query;

    // allow ?theatre= OR ?theater= OR fallback to JWT theatreId
    const theatreIdRaw =
      req.query.theatre || req.query.theater || req.user?.theatreId;

    if (!theatreIdRaw) {
      return res
        .status(400)
        .json({ message: "theatre / theater id is required" });
    }

    if (!start || !end) {
      return res.status(400).json({
        message: "start and end are required in YYYY-MM-DD format",
      });
    }

    if (!mongoose.isValidObjectId(theatreIdRaw)) {
      return res.status(400).json({ message: "Invalid theatre id" });
    }

    const startDate = new Date(start);
    const endDateObj = new Date(end);
    endDateObj.setHours(23, 59, 59, 999);

    const { lookupAndFilter } = buildTheatreReportsPipeline({
      theatreId: theatreIdRaw,
      startDate,
      endDate: endDateObj,
    });

    /* ---------- 1) SUMMARY: total bookings, tickets, revenue ---------- */
    const [summary] = await Booking.aggregate([
      ...lookupAndFilter,
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          totalTickets: { $sum: { $size: "$seats" } }, // seats[] length
          totalRevenue: { $sum: "$totalAmount" }, // from Booking schema
        },
      },
    ]);

    /* ---------- 2) BY DAY: for charts ---------- */
    const byDay = await Booking.aggregate([
      ...lookupAndFilter,
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          bookings: { $sum: 1 },
          tickets: { $sum: { $size: "$seats" } },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    /* ---------- 3) BY MOVIE: top performers ---------- */
    const byMovie = await Booking.aggregate([
      ...lookupAndFilter,
      {
        $group: {
          _id: {
            movie: {
              $ifNull: ["$showtime.movie", "$showtime.movieId"],
            },
            title: {
              $ifNull: ["$showtime.movieTitle", "$showtime.movieName"],
            },
          },
          bookings: { $sum: 1 },
          tickets: { $sum: { $size: "$seats" } },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const stats = summary || {
      totalBookings: 0,
      totalTickets: 0,
      totalRevenue: 0,
    };

    /* ---------- 4) BOOKINGS TABLE: populate user for list ---------- */

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const skip = (page - 1) * limit;

    // base for bookings list
    const bookingsBase = [
      ...lookupAndFilter,
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      {
        $unwind: {
          path: "$user",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          seatCount: { $size: "$seats" },
        },
      },
    ];

    const bookings = await Booking.aggregate([
      ...bookingsBase,
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          createdAt: 1,
          totalAmount: 1,
          seatCount: 1,
          // user
          "user._id": 1,
          "user.name": 1,
          "user.email": 1,
          // showtime
          "showtime._id": 1,
          "showtime.startAt": 1,
          "showtime.date": 1,
          "showtime.time": 1,
          "showtime.screen": 1,
          "showtime.movie": 1,
          "showtime.movieTitle": 1,
          "showtime.movieName": 1,
        },
      },
    ]);

    const totalBookingsAgg = await Booking.aggregate([
      ...bookingsBase,
      { $count: "count" },
    ]);

    const totalBookings = totalBookingsAgg[0]?.count || 0;
    const totalPages = Math.max(Math.ceil(totalBookings / limit), 1);

    return res.json({
      ok: true,
      theatre: theatreIdRaw,
      start,
      end,
      stats,
      byDay,
      byMovie,
      bookings,
      bookingsPagination: {
        page,
        limit,
        total: totalBookings,
        totalPages,
      },
    });
  } catch (err) {
    console.error("[Theaters] GET /reports error:", err);
    return res
      .status(500)
      .json({ message: "Failed to load theatre reports" });
  }
});

/** GET /api/theaters/reports/summary
 *  Lightweight version for Theatre Dashboard "Bookings (period)" chip.
 *  If start/end are not provided, defaults to last 30 days.
 */
router.get("/reports/summary", requireAuth(), async (req, res) => {
  try {
    let { start, end } = req.query;

    const theatreIdRaw =
      req.query.theatre || req.query.theater || req.user?.theatreId;

    if (!theatreIdRaw) {
      return res
        .status(400)
        .json({ message: "theatre / theater id is required" });
    }

    if (!mongoose.isValidObjectId(theatreIdRaw)) {
      return res.status(400).json({ message: "Invalid theatre id" });
    }

    // default to last 30 days if not provided
    const today = new Date();
    if (!end) {
      end = today.toISOString().slice(0, 10);
    }
    if (!start) {
      const d = new Date(end);
      d.setDate(d.getDate() - 29); // end included → 30 days total
      start = d.toISOString().slice(0, 10);
    }

    const startDate = new Date(start);
    const endDateObj = new Date(end);
    endDateObj.setHours(23, 59, 59, 999);

    const { lookupAndFilter } = buildTheatreReportsPipeline({
      theatreId: theatreIdRaw,
      startDate,
      endDate: endDateObj,
    });

    const [summary] = await Booking.aggregate([
      ...lookupAndFilter,
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          totalTickets: { $sum: { $size: "$seats" } },
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
    ]);

    const stats = summary || {
      totalBookings: 0,
      totalTickets: 0,
      totalRevenue: 0,
    };

    return res.json({
      ok: true,
      theatre: theatreIdRaw,
      start,
      end,
      stats,
    });
  } catch (err) {
    console.error("[Theaters] GET /reports/summary error:", err);
    return res
      .status(500)
      .json({ message: "Failed to load theatre summary" });
  }
});

/* =========================================================================
   ADMIN ROUTES + ALIASES
   ========================================================================= */

/** GET /api/theaters/admin/list  */
router.get(
  "/admin/list",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      const filter = isSuperOrOwner(req.user)
        ? {}
        : { _id: getTheatreId(req.user) };
      const theaters = await Theater.find(filter).sort({ createdAt: -1 }).lean();
      res.json({ data: theaters });
    } catch (err) {
      console.error("[Theaters] GET /admin/list error:", err);
      res.status(500).json({ message: "Failed to fetch theaters" });
    }
  }
);

/** LIST alias: GET /api/theaters/admin/theaters */
router.get(
  "/admin/theaters",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      const filter = isSuperOrOwner(req.user)
        ? {}
        : { _id: getTheatreId(req.user) };
      const theaters = await Theater.find(filter).sort({ createdAt: -1 }).lean();
      res.json({ data: theaters });
    } catch (err) {
      console.error("[Theaters] GET /admin/theaters error:", err);
      res.status(500).json({ message: "Failed to fetch theaters" });
    }
  }
);

/** LIST mine: GET /api/theaters/admin/theaters/mine */
router.get(
  "/admin/theaters/mine",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      const myId = getTheatreId(req.user);
      const theaters = await Theater.find({ _id: myId }).lean();
      res.json({ data: theaters });
    } catch (err) {
      console.error("[Theaters] GET /admin/theaters/mine error:", err);
      res.status(500).json({ message: "Failed to fetch my theaters" });
    }
  }
);

/** POST /api/theaters/admin  */
router.post(
  "/admin",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  upload.single("image"),
  async (req, res) => {
    try {
      await createTheaterHandler(req, res);
    } catch (err) {
      console.error("[Theaters] POST /admin error:", err);
      const code = Number(err?.status) || 500;
      res
        .status(code)
        .json({ message: "Failed to create theater", error: err.message });
    }
  }
);

/** POST alias: /api/theaters/admin/theaters */
router.post(
  "/admin/theaters",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  upload.single("image"),
  async (req, res) => {
    try {
      await createTheaterHandler(req, res);
    } catch (err) {
      console.error("[Theaters] POST /admin/theaters error:", err);
      const code = Number(err?.status) || 500;
      res
        .status(code)
        .json({ message: "Failed to create theater", error: err.message });
    }
  }
);

/** PUT /api/theaters/admin/:id */
router.put(
  "/admin/:id",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  upload.single("image"),
  async (req, res) => {
    try {
      await updateTheaterHandler(req, res);
    } catch (err) {
      console.error("[Theaters] PUT /admin/:id error:", err);
      const code = Number(err?.status) || 500;
      res
        .status(code)
        .json({ message: "Failed to update theater", error: err.message });
    }
  }
);

/** PUT alias: /api/theaters/admin/theaters/:id */
router.put(
  "/admin/theaters/:id",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  upload.single("image"),
  async (req, res) => {
    try {
      await updateTheaterHandler(req, res);
    } catch (err) {
      console.error("[Theaters] PUT /admin/theaters/:id error:", err);
      const code = Number(err?.status) || 500;
      res
        .status(code)
        .json({ message: "Failed to update theater", error: err.message });
    }
  }
);

/** PATCH /api/theaters/admin/:id/amenities */
router.patch(
  "/admin/:id/amenities",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      await updateAmenitiesHandler(req, res);
    } catch (err) {
      console.error("[Theaters] PATCH /admin/:id/amenities error:", err);
      const code = Number(err?.status) || 500;
      res.status(code).json({
        message: "Failed to update amenities",
        error: err.message,
      });
    }
  }
);

/** PATCH alias: /api/theaters/admin/theaters/:id/amenities */
router.patch(
  "/admin/theaters/:id/amenities",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      await updateAmenitiesHandler(req, res);
    } catch (err) {
      console.error("[Theaters] PATCH /admin/theaters/:id/amenities error:", err);
      const code = Number(err?.status) || 500;
      res.status(code).json({
        message: "Failed to update amenities",
        error: err.message,
      });
    }
  }
);

/* =========================================================================
   PUBLIC
   ========================================================================= */

/** GET /api/theaters  */
router.get("/", async (req, res) => {
  try {
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const { q, city, page = 1, limit = 12 } = req.query;
    const filter = {};

    if (q) {
      filter.$or = [
        { name: new RegExp(q, "i") },
        { city: new RegExp(q, "i") },
        { address: new RegExp(q, "i") },
      ];
    }

    if (city && city !== "All") filter.city = city;

    const safeLimit = Math.min(Number(limit) || 12, 1000);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [theaters, totalCount, cities] = await Promise.all([
      Theater.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Theater.countDocuments(filter),
      Theater.distinct("city"),
    ]);

    const screenCounts = await Screen.aggregate([
      {
        $group: {
          _id: { $ifNull: ["$theatreId", "$theater"] },
          count: { $sum: 1 },
        },
      },
    ]);

    const countMap = new Map(screenCounts.map((c) => [String(c._id), c.count]));

    const enriched = theaters.map((t) => ({
      ...t,
      screensCount: countMap.get(String(t._id)) || 0,
    }));

    res.json({
      ok: true,
      theaters: enriched,
      count: totalCount,
      cities,
      page: safePage,
      limit: safeLimit,
      hasMore: skip + enriched.length < totalCount,
    });
  } catch (err) {
    console.error("[Theaters] GET / error:", err);
    res.status(500).json({ message: "Failed to fetch theaters" });
  }
});

/** GET /api/theaters/:id  */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid theater id" });

    const theater = await Theater.findById(id).lean();
    if (!theater) return res.status(404).json({ message: "Theater not found" });

    const screensCount = await Screen.countDocuments({
      $or: [{ theatreId: id }, { theater: new mongoose.Types.ObjectId(id) }],
    });

    res.json({ ...theater, screensCount });
  } catch (err) {
    console.error("[Theaters] GET /:id error:", err);
    res.status(500).json({ message: "Failed to fetch theater" });
  }
});

/** GET /api/theaters/:theaterId/screens  */
router.get("/:theaterId/screens", async (req, res) => {
  try {
    const { theaterId } = req.params;
    if (!isValidId(theaterId))
      return res.status(400).json({ error: "Invalid theater id" });

    const screens = await Screen.find({
      $or: [{ theatreId: theaterId }, { theater: theaterId }],
    }).lean();

    res.json({ data: screens || [] });
  } catch (err) {
    console.error("[Theaters] GET /:theaterId/screens error:", err);
    res.status(500).json({ error: "Failed to load screens" });
  }
});

/* =========================================================================
   EXTRA: Frontend compatibility aliases
   ========================================================================= */

/** alias for AdminShowtimes etc.: GET /api/theaters/screens/by-theatre/:id  */
router.get("/screens/by-theatre/:id", requireAuth(), async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidId(id)) return res.status(400).json({ error: "Invalid theatre id" });

    const list = await Screen.find({
      $or: [{ theatreId: id }, { theater: id }],
    })
      .select("_id name rows cols seats theatreId theater")
      .lean();

    res.json(list);
  } catch (err) {
    console.error("[Theaters] alias /screens/by-theatre/:id error:", err);
    res.status(500).json({ error: "Failed to load screens" });
  }
});

/* ----------------------------- DELETE ---------------------------------- */
router.delete(
  "/admin/:id",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      await deleteTheaterHandler(req, res);
    } catch (err) {
      console.error("[Theaters] DELETE /admin/:id error:", err);
      const code = Number(err?.status) || 500;
      res
        .status(code)
        .json({ message: "Failed to delete theater", error: err.message });
    }
  }
);

/** DELETE alias: /api/theaters/admin/theaters/:id */
router.delete(
  "/admin/theaters/:id",
  requireAuth(),
  requireAdmin,
  requireScopedTheatre,
  async (req, res) => {
    try {
      await deleteTheaterHandler(req, res);
    } catch (err) {
      console.error("[Theaters] DELETE /admin/theaters/:id error:", err);
      const code = Number(err?.status) || 500;
      res
        .status(code)
        .json({ message: "Failed to delete theater", error: err.message });
    }
  }
);

/* ----------------------- Multer error handler --------------------------- */
router.use((err, _req, res, next) => {
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ message: "File too large (max 5MB)" });
    return res.status(400).json({ message: err.message });
  }
  if (err && err.message && err.message.includes("Cloudinary")) {
    return res
      .status(500)
      .json({ message: "Image upload failed", error: err.message });
  }
  next(err);
});

export default router;
