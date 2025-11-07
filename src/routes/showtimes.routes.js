// backend/src/routes/showtimes.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Showtime from "../models/Showtime.js";
import Screen from "../models/Screen.js";
import SeatLock from "../models/SeatLock.js";
import Theater from "../models/Theater.js";
import Movie from "../models/Movie.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  requireScopedTheatre,
  assertInScopeOrThrow,
  isSuperOrOwner,
  getTheatreId,
} from "../middleware/scope.js";

const router = Router();
/** ✅ mount under /api/showtimes so GET /api/showtimes works */
router.routesPrefix = "/api/showtimes";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/* -------------------------------------------------------------------------- */
/* Time helpers (IST-aware)                                                   */
/* -------------------------------------------------------------------------- */
function istBoundsUtc(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return {};
  const start = new Date(`${ymd}T00:00:00.000+05:30`);
  const end = new Date(`${ymd}T23:59:59.999+05:30`);
  return { startUtc: start, endUtc: end };
}
function toYmdIST(d = new Date()) {
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const day = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const nowUtc = () => new Date();

/* -------------------------------------------------------------------------- */
/* Misc helpers                                                               */
/* -------------------------------------------------------------------------- */
const seatKey = (r, c) => `${Number(r)}:${Number(c)}`;

function toDto(s) {
  const theater =
    s.theater && typeof s.theater === "object"
      ? { _id: s.theater._id, name: s.theater.name, city: s.theater.city, address: s.theater.address }
      : { _id: s.theater, name: undefined, city: s.city };

  const screen =
    s.screen && typeof s.screen === "object"
      ? { _id: s.screen._id, name: s.screen.name, rows: s.screen.rows, cols: s.screen.cols, format: s.screen.format }
      : { _id: s.screen, name: undefined, rows: undefined, cols: undefined, format: undefined };

  const movie =
    s.movie && typeof s.movie === "object"
      ? {
          _id: s.movie._id,
          title: s.movie.title,
          posterUrl: s.movie.posterUrl,
          runtime: s.movie.runtime ?? s.movie.durationMins,
          languages: s.movie.languages,
          censorRating: s.movie.censorRating,
          genres: s.movie.genres,
        }
      : { _id: s.movie };

  const seatsAvailable = Array.isArray(s.seats)
    ? s.seats.filter((x) => x.status === "AVAILABLE").length
    : undefined;

  return {
    _id: s._id,
    startTime: s.startTime,
    basePrice: s.basePrice,
    dynamicPricing: s.dynamicPricing,
    city: s.city || theater.city,

    theater,
    screen,
    movie,

    theaterId: theater._id,
    theaterName: theater.name,
    screenId: screen._id,
    screenName: screen.name,
    format: screen.format,
    language: Array.isArray(movie.languages) ? movie.languages[0] : undefined,

    seatsAvailable,
  };
}

/** Ensure showtime.seats exists (flat array of {row,col,status}) */
async function ensureSeatsInitialized(showtime) {
  if (Array.isArray(showtime.seats) && showtime.seats.length > 0) return showtime;

  let rows = showtime.screen?.rows;
  let cols = showtime.screen?.cols;

  if (!rows || !cols) {
    if (showtime.screen) {
      const screenDoc = await Screen.findById(showtime.screen).lean();
      rows = Number(screenDoc?.rows) || 10;
      cols = Number(screenDoc?.cols) || 10;
    } else {
      rows = 10;
      cols = 10;
    }
  }

  const seats = [];
  for (let r = 1; r <= Number(rows); r++) {
    for (let c = 1; c <= Number(cols); c++) {
      seats.push({ row: r, col: c, status: "AVAILABLE" });
    }
  }

  showtime.seats = seats;
  await showtime.save();
  return showtime;
}

/** Sync showtime.seats against active SeatLock docs */
async function reconcileLocks(showtime) {
  const now = new Date();

  await SeatLock.deleteMany({
    showtime: showtime._id,
    status: "HELD",
    lockedUntil: { $lte: now },
  });

  const active = await SeatLock.find({
    showtime: showtime._id,
    status: "HELD",
    lockedUntil: { $gt: now },
  })
    .select("seat")
    .lean();

  const lockedSet = new Set(active.map((l) => l.seat));
  let dirty = false;

  for (let i = 0; i < showtime.seats.length; i++) {
    const s = showtime.seats[i];
    const k = seatKey(s.row, s.col);

    if (lockedSet.has(k)) {
      if (s.status !== "BOOKED" && s.status !== "LOCKED") {
        showtime.seats[i].status = "LOCKED";
        dirty = true;
      }
    } else {
      if (s.status === "LOCKED") {
        showtime.seats[i].status = "AVAILABLE";
        dirty = true;
      }
    }
  }

  if (dirty) await showtime.save();
}

/* -------------------------------------------------------------------------- */
/* LIST: GET /api/showtimes?movieId&theaterId&screenId&city&date=YYYY-MM-DD   */
/* Hides past days; on today, hides shows already started.                    */
/* -------------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const { movieId, theaterId, screenId, city, date } = req.query;

    const q = {};
    if (movieId && mongoose.isValidObjectId(String(movieId))) q.movie = new mongoose.Types.ObjectId(String(movieId));
    if (theaterId && mongoose.isValidObjectId(String(theaterId))) q.theater = new mongoose.Types.ObjectId(String(theaterId));
    if (screenId && mongoose.isValidObjectId(String(screenId))) q.screen = new mongoose.Types.ObjectId(String(screenId));
    if (city && String(city).trim()) q.city = new RegExp(`^${String(city).trim()}$`, "i");

    const todayYmd = toYmdIST();
    const ymd = date ? (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10)) : null;

    if (!ymd) {
      q.startTime = { $gte: nowUtc() };
    } else if (ymd < todayYmd) {
      return res.json([]);
    } else if (ymd === todayYmd) {
      const { endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: nowUtc(), $lt: endUtc };
    } else {
      const { startUtc, endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: startUtc, $lt: endUtc };
    }

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.status(200).json(docs.map(toDto));
  } catch (err) {
    console.error("❌ GET /showtimes error:", err);
    return res.status(500).json({ message: "Failed to fetch showtimes", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* NEW: GET /api/showtimes/my-theatre?date=YYYY-MM-DD&movieId=&screenId=      */
/* Returns only the logged-in manager's theatre (from JWT).                   */
/* -------------------------------------------------------------------------- */
router.get("/my-theatre", async (req, res) => {
  try {
    const h = req.headers.authorization || "";
    const [, token] = h.split(" ");
    if (!token) return res.status(401).json({ message: "Missing token" });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const theatreId = decoded?.theatreId;
    if (!theatreId || !mongoose.isValidObjectId(String(theatreId))) {
      return res.json([]);
    }

    const { movieId, screenId, date } = req.query;

    const q = { theater: new mongoose.Types.ObjectId(String(theatreId)) };
    if (movieId && mongoose.isValidObjectId(String(movieId))) q.movie = new mongoose.Types.ObjectId(String(movieId));
    if (screenId && mongoose.isValidObjectId(String(screenId))) q.screen = new mongoose.Types.ObjectId(String(screenId));

    const todayYmd = toYmdIST();
    const ymd = date ? (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10)) : null;

    if (!ymd) {
      q.startTime = { $gte: nowUtc() };
    } else if (ymd < todayYmd) {
      return res.json([]);
    } else if (ymd === todayYmd) {
      const { endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: nowUtc(), $lt: endUtc };
    } else {
      const { startUtc, endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: startUtc, $lt: endUtc };
    }

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(docs.map(toDto));
  } catch (e) {
    console.error("❌ GET /showtimes/my-theatre error:", e);
    return res.status(500).json({ message: "Failed to fetch theatre showtimes" });
  }
});

/* -------------------------------------------------------------------------- */
/* AVAILABILITY: GET /api/showtimes/availability                              */
/* -------------------------------------------------------------------------- */
router.get("/availability", async (req, res) => {
  try {
    const { from, to } = req.query;

    const startY = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : toYmdIST();
    const endY =
      to && /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? to
        : new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    function denseYmdRange(fromY, toY) {
      const out = [];
      const start = new Date(`${fromY}T00:00:00.000+05:30`);
      const end = new Date(`${toY}T00:00:00.000+05:30`);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        out.push(`${y}-${m}-${day}`);
      }
      return out;
    }

    const dates = denseYmdRange(startY, endY);
    return res.json({ dates });
  } catch (e) {
    console.error("❌ GET /showtimes/availability error:", e);
    return res.status(500).json({ message: "Failed to fetch availability" });
  }
});

/* -------------------------------------------------------------------------- */
/* CITIES: GET /api/showtimes/cities                                          */
/* -------------------------------------------------------------------------- */
router.get("/cities", async (req, res) => {
  try {
    const { movieId, date } = req.query;

    const q = {};
    if (movieId && mongoose.isValidObjectId(String(movieId))) {
      q.movie = new mongoose.Types.ObjectId(String(movieId));
    }

    const todayYmd = toYmdIST();
    const ymd = date
      ? (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10))
      : todayYmd;

    if (ymd < todayYmd) {
      return res.json([]);
    } else if (ymd === todayYmd) {
      const { endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: nowUtc(), $lt: endUtc };
    } else {
      const { startUtc, endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: startUtc, $lt: endUtc };
    }

    const rows = await Showtime.aggregate([
      { $match: q },
      { $group: { _id: "$city" } },
      { $sort: { _id: 1 } },
    ]);

    const cities = rows.map((r) => r._id).filter(Boolean);
    return res.json(cities);
  } catch (e) {
    console.error("❌ GET /showtimes/cities error:", e);
    return res.status(500).json({ message: "Failed to fetch showtime cities" });
  }
});

/* -------------------------------------------------------------------------- */
/* MOVIES (dropdown): GET /api/showtimes/movies                               */
/* -------------------------------------------------------------------------- */
router.get("/movies", async (req, res) => {
  try {
    const { city, date } = req.query;

    const q = {};
    const todayYmd = toYmdIST();
    const ymd = date
      ? (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10))
      : null;

    if (!ymd) {
      q.startTime = { $gte: nowUtc() };
    } else if (ymd < todayYmd) {
      return res.json([]);
    } else if (ymd === todayYmd) {
      const { endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: nowUtc(), $lt: endUtc };
    } else {
      const { startUtc, endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: startUtc, $lt: endUtc };
    }

    if (city && String(city).trim()) {
      q.city = new RegExp(`^${String(city).trim()}$`, "i");
    }

    const rows = await Showtime.aggregate([
      { $match: q },
      { $group: { _id: "$movie" } },
      { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "movie" } },
      { $unwind: "$movie" },
      { $project: { _id: "$movie._id", title: "$movie.title" } },
      { $sort: { title: 1 } },
    ]);

    return res.json(rows);
  } catch (e) {
    console.error("❌ GET /showtimes/movies error:", e);
    return res.status(500).json({ message: "Failed to fetch showtime movies" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET ONE: /api/showtimes/:id -> seats + locks reconciled                    */
/* -------------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const showtime = await Showtime.findById(req.params.id)
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format");

    if (!showtime) return res.status(404).json({ message: "Showtime not found" });

    await ensureSeatsInitialized(showtime);
    await reconcileLocks(showtime);

    return res.json({
      ...toDto(showtime.toObject()),
      seats: showtime.seats,
    });
  } catch (err) {
    console.error("❌ GET /showtimes/:id error:", err);
    return res.status(500).json({ message: "Failed to fetch showtime", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* CREATE: POST /api/showtimes (scoped)                                       */
/* Accepts aliases from frontend payload                                      */
/* -------------------------------------------------------------------------- */
router.post("/", requireAuth, requireAdmin, requireScopedTheatre, async (req, res) => {
  try {
    const movie = req.body.movie ?? req.body.movieId;
    const theater = req.body.theater ?? req.body.theaterId ?? req.body.theatreId;
    const screen = req.body.screen ?? req.body.screenId;
    const startTime = req.body.startTime ?? req.body.startAt;
    const basePrice = req.body.basePrice ?? req.body.price ?? req.body.amount;
    const dynamicPricing = req.body.dynamicPricing;

    if (!movie || !theater || !screen || !startTime || basePrice == null) {
      return res.status(400).json({ message: "movie, theater, screen, startTime, basePrice are required" });
    }

    const [m, t, s] = await Promise.all([
      Movie.findById(movie).select("_id").lean(),
      Theater.findById(theater).select("_id city").lean(),
      Screen.findById(screen).select("_id theater rows cols").lean(),
    ]);
    if (!m || !t || !s) return res.status(400).json({ message: "Invalid movie/theater/screen" });

    if (String(s.theater) !== String(t._id)) {
      return res.status(400).json({ message: "Screen does not belong to the selected theater" });
    }

    assertInScopeOrThrow(t._id, req);

    const when = new Date(startTime);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ message: "Invalid startTime" });
    when.setSeconds(0, 0);

    const doc = await Showtime.create({
      movie,
      theater: t._id,
      screen: s._id,
      city: t.city,
      startTime: when,
      basePrice: Number(basePrice),
      dynamicPricing: Boolean(dynamicPricing),
    });

    if (!doc.seats?.length) await ensureSeatsInitialized(doc);

    const populated = await Showtime.findById(doc._id)
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.status(201).json(toDto(populated));
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ message: "Showtime already exists for this screen & minute" });
    }
    const code = Number(e?.status) || 500;
    console.error("❌ POST /showtimes error:", e);
    return res.status(code).json({ message: "Failed to create showtime", error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* UPDATE: PATCH /api/showtimes/:id (scoped)                                  */
/* -------------------------------------------------------------------------- */
router.patch("/:id", requireAuth, requireAdmin, requireScopedTheatre, async (req, res) => {
  try {
    const doc = await Showtime.findById(req.params.id).populate("theater", "_id city");
    if (!doc) return res.status(404).json({ message: "Showtime not found" });

    assertInScopeOrThrow(doc.theater?._id || doc.theater, req);

    if (req.body.theater && String(req.body.theater) !== String(doc.theater?._id || doc.theater)) {
      return res.status(400).json({ message: "Cannot change theater via update" });
    }
    if (req.body.screen && String(req.body.screen) !== String(doc.screen)) {
      return res.status(400).json({ message: "Cannot change screen via update" });
    }

    const newStart = req.body.startTime ?? req.body.startAt;
    const newPrice = req.body.basePrice ?? req.body.price ?? req.body.amount;

    if (newStart !== undefined) {
      const d = new Date(newStart);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "Invalid startTime" });
      d.setSeconds(0, 0);
      doc.startTime = d;
    }
    if (newPrice != null) doc.basePrice = Number(newPrice);
    if (typeof req.body.dynamicPricing === "boolean") doc.dynamicPricing = req.body.dynamicPricing;

    await doc.save();

    const populated = await Showtime.findById(doc._id)
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(toDto(populated));
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ message: "Another showtime already exists at that minute on this screen" });
    }
    const code = Number(e?.status) || 500;
    console.error("❌ PATCH /showtimes/:id error:", e);
    return res.status(code).json({ message: "Failed to update showtime", error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE: DELETE /api/showtimes/:id (scoped)                                 */
/* -------------------------------------------------------------------------- */
router.delete("/:id", requireAuth, requireAdmin, requireScopedTheatre, async (req, res) => {
  try {
    const doc = await Showtime.findById(req.params.id).populate("theater", "_id");
    if (!doc) return res.status(404).json({ message: "Showtime not found" });

    assertInScopeOrThrow(doc.theater?._id || doc.theater, req);

    await Showtime.findByIdAndDelete(doc._id);
    await SeatLock.deleteMany({ showtime: doc._id, status: { $in: ["HELD", "PENDING"] } });

    return res.json({ ok: true });
  } catch (e) {
    const code = Number(e?.status) || 500;
    console.error("❌ DELETE /showtimes/:id error:", e);
    return res.status(code).json({ message: "Failed to delete showtime", error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* CONVENIENCE: GET /api/showtimes/movies/:id                                 */
/* -------------------------------------------------------------------------- */
router.get("/movies/:id", async (req, res) => {
  try {
    const { city, date } = req.query;
    const movieId = String(req.params.id);
    if (!mongoose.isValidObjectId(movieId)) return res.status(400).json({ message: "Invalid movie id" });

    const q = { movie: new mongoose.Types.ObjectId(movieId) };
    if (city && String(city).trim()) q.city = new RegExp(`^${String(city).trim()}$`, "i");

    const todayYmd = toYmdIST();
    const ymd = date ? (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10)) : null;

    if (!ymd) {
      q.startTime = { $gte: nowUtc() };
    } else if (ymd < todayYmd) {
      return res.json([]);
    } else if (ymd === todayYmd) {
      const { endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: nowUtc(), $lt: endUtc };
    } else {
      const { startUtc, endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: startUtc, $lt: endUtc };
    }

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(docs.map(toDto));
  } catch {
    return res.status(500).json({ message: "Failed to fetch movie showtimes" });
  }
});

/* -------------------------------------------------------------------------- */
/* CONVENIENCE: GET /api/showtimes/theaters/:id                               */
/* -------------------------------------------------------------------------- */
router.get("/theaters/:id", async (req, res) => {
  try {
    const { date } = req.query;
    const theaterId = String(req.params.id);
    if (!mongoose.isValidObjectId(theaterId)) return res.status(400).json({ message: "Invalid theater id" });

    const q = { theater: new mongoose.Types.ObjectId(theaterId) };

    const todayYmd = toYmdIST();
    const ymd = date ? (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10)) : null;

    if (!ymd) {
      q.startTime = { $gte: nowUtc() };
    } else if (ymd < todayYmd) {
      return res.json([]);
    } else if (ymd === todayYmd) {
      const { endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: nowUtc(), $lt: endUtc };
    } else {
      const { startUtc, endUtc } = istBoundsUtc(ymd);
      q.startTime = { $gte: startUtc, $lt: endUtc };
    }

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate("movie", "title posterUrl runtime languages censorRating genres")
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(docs.map(toDto));
  } catch {
    return res.status(500).json({ message: "Failed to fetch theater showtimes" });
  }
});

export default router;
