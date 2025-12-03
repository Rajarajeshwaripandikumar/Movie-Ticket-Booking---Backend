// backend/src/routes/showtimes.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import Showtime from "../models/Showtime.js";
import SeatLock from "../models/SeatLock.js";
import Theater from "../models/Theater.js";
import Movie from "../models/Movie.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  requireScopedTheatre,
  assertInScopeOrThrow,
  getTheatreId,
} from "../middleware/scope.js";

const router = Router();
/** mount under /api/showtimes so GET /api/showtimes works */
router.routesPrefix = "/api/showtimes";

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

const isId = (id) => mongoose.isValidObjectId(String(id || "").trim());

function safeObjectId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  if (!mongoose.isValidObjectId(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/** Accepts id as string or object with _id/id and returns ObjectId or null */
function coerceId(input) {
  if (!input) return null;

  if (typeof input === "string") {
    if (!isId(input)) return null;
    return safeObjectId(input);
  }

  if (typeof input === "object") {
    const maybeId = input._id || input.id;
    if (maybeId && typeof maybeId === "string" && isId(maybeId)) {
      return safeObjectId(maybeId);
    }
  }

  return null;
}

function toDto(s) {
  const theater =
    s.theater && typeof s.theater === "object"
      ? {
          _id: s.theater._id,
          name: s.theater.name,
          city: s.theater.city,
          address: s.theater.address,
        }
      : { _id: s.theater, name: undefined, city: s.city };

  const screen =
    s.screen && typeof s.screen === "object"
      ? {
          _id: s.screen._id,
          name: s.screen.name,
          rows: s.screen.rows,
          cols: s.screen.cols,
          format: s.screen.format,
        }
      : {
          _id: s.screen,
          name: undefined,
          rows: undefined,
          cols: undefined,
          format: undefined,
        };

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

  const seatsAvailable = Array.isArray(s.seats) ? s.seats.length : undefined;

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

/**
 * Delegate to Showtime model's ensureSeatsInitialized() instance method,
 * which correctly sets seatId / row / col / seatType / price.
 */
async function ensureSeatsInitialized(showtime) {
  if (showtime && typeof showtime.ensureSeatsInitialized === "function") {
    return showtime.ensureSeatsInitialized();
  }
  return showtime;
}

/* -------------------------------------------------------------------------- */
/* Seat snapshot / lock helpers (for seats UI + consistency with bookings)   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical seat key from snapshot seat object.
 * Uses seatId if present, else "row:col".
 */
const seatKeyForSnapshot = (s) => {
  if (!s) return null;
  if (s.seatId) return String(s.seatId);
  if (s.row !== undefined && s.col !== undefined) {
    return `${Number(s.row)}:${Number(s.col)}`;
  }
  return null;
};

/**
 * Reconcile active SeatLock docs into the in-memory showtime.seats array.
 * - Removes expired locks
 * - Sets status to LOCKED when there is an active lock
 * - Releases LOCKED -> AVAILABLE if no active lock
 * - DOES NOT override BOOKED seats
 */
async function reconcileLocks(showtime) {
  if (!showtime || !Array.isArray(showtime.seats)) return;

  const now = new Date();

  // Remove expired locks (TTL index should also handle this)
  await SeatLock.deleteMany({
    showtime: showtime._id,
    status: "HELD",
    lockedUntil: { $lte: now },
  });

  const activeLocks = await SeatLock.find({
    showtime: showtime._id,
    status: "HELD",
    lockedUntil: { $gt: now },
  })
    .select("seat")
    .lean();

  const lockedSet = new Set(activeLocks.map((l) => String(l.seat)));
  let dirty = false;

  for (let i = 0; i < showtime.seats.length; i++) {
    const seat = showtime.seats[i];
    const key = seatKeyForSnapshot(seat);
    if (!key) continue;

    if (lockedSet.has(key)) {
      if (seat.status !== "BOOKED" && seat.status !== "LOCKED") {
        showtime.seats[i].status = "LOCKED";
        dirty = true;
      }
    } else {
      if (seat.status === "LOCKED") {
        showtime.seats[i].status = "AVAILABLE";
        dirty = true;
      }
    }
  }

  if (dirty && typeof showtime.save === "function") {
    await showtime.save();
  }
}

/* -------------------------------------------------------------------------- */
/* LIST: GET /api/showtimes?movieId&theaterId&screenId&city&date=YYYY-MM-DD   */
/* Also supports theatre/theater/theatreId used by frontend                   */
/* -------------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const {
      movieId,
      theaterId,
      theatreId,
      theater,
      theatre,
      screenId,
      city,
      date,
    } = req.query;

    const q = {};

    // 🎯 Theatre filter normalization:
    // accept ?theatre=, ?theater=, ?theaterId=, ?theatreId=
    const theatreFilterRaw =
      theaterId || theatreId || theater || theatre;

    if (movieId && isId(movieId)) q.movie = safeObjectId(movieId);

    if (theatreFilterRaw && isId(theatreFilterRaw)) {
      q.theater = safeObjectId(theatreFilterRaw);
    }

    if (screenId && isId(screenId)) q.screen = safeObjectId(screenId);
    if (city && String(city).trim())
      q.city = new RegExp(`^${String(city).trim()}$`, "i");

    const todayYmd = toYmdIST();
    const ymd = date
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(date).toISOString().slice(0, 10)
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

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate(
        "movie",
        "title posterUrl runtime languages censorRating genres"
      )
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.status(200).json(docs.map(toDto));
  } catch (err) {
    console.error("❌ GET /showtimes error:", err);
    return res
      .status(500)
      .json({ message: "Failed to fetch showtimes", error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* NEW: GET /api/showtimes/my-theatre                                         */
/* -------------------------------------------------------------------------- */
router.get("/my-theatre", requireAuth(), async (req, res) => {
  try {
    let theatreId =
      (typeof getTheatreId === "function" && getTheatreId(req)) || null;

    if (!theatreId) {
      const t = await Theater.findOne({
        $or: [
          { owner: req.user.id },
          { admin: req.user.id },
          { manager: req.user.id },
          { createdBy: req.user.id },
        ],
      })
        .select("_id")
        .lean();
      theatreId = t?._id;
    }

    if (!theatreId || !isId(theatreId)) {
      return res.json([]);
    }

    const { movieId, screenId, date } = req.query;

    const q = { theater: safeObjectId(theatreId) };
    if (movieId && isId(movieId)) q.movie = safeObjectId(movieId);
    if (screenId && isId(screenId)) q.screen = safeObjectId(screenId);

    const todayYmd = toYmdIST();
    const ymd = date
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(date).toISOString().slice(0, 10)
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

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate(
        "movie",
        "title posterUrl runtime languages censorRating genres"
      )
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(docs.map(toDto));
  } catch (e) {
    console.error("❌ GET /showtimes/my-theatre error:", e);
    return res
      .status(500)
      .json({ message: "Failed to fetch theatre showtimes" });
  }
});

/* -------------------------------------------------------------------------- */
/* AVAILABILITY: GET /api/showtimes/availability                              */
/* -------------------------------------------------------------------------- */
router.get("/availability", async (req, res) => {
  try {
    const { from, to } = req.query;

    const startY =
      from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : toYmdIST();
    const endY =
      to && /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? to
        : new Date(Date.now() + 13 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);

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
    return res
      .status(500)
      .json({ message: "Failed to fetch availability" });
  }
});

/* -------------------------------------------------------------------------- */
/* CITIES: GET /api/showtimes/cities                                          */
/* -------------------------------------------------------------------------- */
router.get("/cities", async (req, res) => {
  try {
    const { movieId, date } = req.query;

    const q = {};
    if (movieId && isId(movieId)) {
      q.movie = safeObjectId(movieId);
    }

    const todayYmd = toYmdIST();
    const ymd = date
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(date).toISOString().slice(0, 10)
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
    return res
      .status(500)
      .json({ message: "Failed to fetch showtime cities" });
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
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(date).toISOString().slice(0, 10)
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
      {
        $lookup: {
          from: "movies",
          localField: "_id",
          foreignField: "_id",
          as: "movie",
        },
      },
      { $unwind: "$movie" },
      { $project: { _id: "$movie._id", title: "$movie.title" } },
      { $sort: { title: 1 } },
    ]);

    return res.json(rows);
  } catch (e) {
    console.error("❌ GET /showtimes/movies error:", e);
    return res
      .status(500)
      .json({ message: "Failed to fetch showtime movies" });
  }
});

/* -------------------------------------------------------------------------- */
/* CONVENIENCE: GET /api/showtimes/movies/:id                                 */
/* -------------------------------------------------------------------------- */
router.get("/movies/:id", async (req, res) => {
  try {
    const { city, date } = req.query;
    const movieId = String(req.params.id);
    if (!isId(movieId))
      return res.status(400).json({ message: "Invalid movie id" });

    const q = { movie: safeObjectId(movieId) };
    if (city && String(city).trim())
      q.city = new RegExp(`^${String(city).trim()}$`, "i");

    const todayYmd = toYmdIST();
    const ymd = date
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(date).toISOString().slice(0, 10)
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

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate(
        "movie",
        "title posterUrl runtime languages censorRating genres"
      )
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(docs.map(toDto));
  } catch (err) {
    console.error("❌ GET /showtimes/movies/:id error:", err);
    return res
      .status(500)
      .json({ message: "Failed to fetch movie showtimes" });
  }
});

/* -------------------------------------------------------------------------- */
/* CONVENIENCE: GET /api/showtimes/theaters/:id                               */
/* -------------------------------------------------------------------------- */
router.get("/theaters/:id", async (req, res) => {
  try {
    const { date, screenId } = req.query;
    const theaterId = String(req.params.id);

    if (!isId(theaterId)) {
      return res.status(400).json({ message: "Invalid theater id" });
    }

    const q = { theater: safeObjectId(theaterId) };

    if (screenId && isId(screenId)) {
      q.screen = safeObjectId(screenId);
    }

    const todayYmd = toYmdIST();
    const ymd = date
      ? /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(date).toISOString().slice(0, 10)
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

    const docs = await Showtime.find(q)
      .sort({ startTime: 1 })
      .populate(
        "movie",
        "title posterUrl runtime languages censorRating genres"
      )
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format")
      .lean();

    return res.json(docs.map(toDto));
  } catch (err) {
    console.error("❌ GET /showtimes/theaters/:id error:", err);
    return res
      .status(500)
      .json({ message: "Failed to fetch theater showtimes" });
  }
});

/* -------------------------------------------------------------------------- */
/* NEW: SEAT MAP: GET /api/showtimes/:id/seats                                */
/* -------------------------------------------------------------------------- */
router.get("/:id/seats", requireAuth(), async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!isId(id))
      return res.status(400).json({ ok: false, error: "Invalid showtime id" });

    let showtime = await Showtime.findById(id)
      .populate(
        "movie",
        "title posterUrl runtime languages censorRating genres"
      )
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format");

    if (!showtime)
      return res
        .status(404)
        .json({ ok: false, error: "Showtime not found" });

    await ensureSeatsInitialized(showtime);
    await reconcileLocks(showtime);

    const dtoBase = toDto(
      showtime.toObject ? showtime.toObject() : showtime
    );
    const seats = Array.isArray(showtime.seats) ? showtime.seats : [];

    const rowsMap = new Map();
    for (const seat of seats) {
      const r = seat.row ?? 0;
      if (!rowsMap.has(r)) rowsMap.set(r, []);
      rowsMap.get(r).push(seat);
    }

    const layout = Array.from(rowsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([rowNumber, rowSeats]) => ({
        row: rowNumber,
        seats: rowSeats.sort(
          (a, b) => (a.col ?? 0) - (b.col ?? 0)
        ),
      }));

    return res.json({
      ok: true,
      ...dtoBase,
      seats,
      layout,
    });
  } catch (err) {
    console.error("❌ GET /showtimes/:id/seats error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load seats" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET ONE: /api/showtimes/:id -> seats snapshot                              */
/* -------------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!isId(id))
      return res.status(400).json({ message: "Invalid showtime id" });

    const showtime = await Showtime.findById(id)
      .populate(
        "movie",
        "title posterUrl runtime languages censorRating genres"
      )
      .populate("theater", "name city address")
      .populate("screen", "name rows cols format");

    if (!showtime)
      return res.status(404).json({ message: "Showtime not found" });

    await ensureSeatsInitialized(showtime);

    return res.json({
      ...toDto(showtime.toObject ? showtime.toObject() : showtime),
      seats: showtime.seats,
    });
  } catch (err) {
    console.error("❌ GET /showtimes/:id error:", err);
    return res.status(500).json({
      message: "Failed to fetch showtime",
      error: err.message,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* CREATE: POST /api/showtimes (scoped)                                       */
/* -------------------------------------------------------------------------- */
router.post(
  "/",
  (req, res, next) => {
    console.log("🛎  POST /api/showtimes pipeline start");
    next();
  },
  requireAuth(),
  (req, res, next) => {
    console.log(
      "✅ requireAuth() passed for POST /api/showtimes, user:",
      req.user?.id,
      "role:",
      req.user?.role
    );
    next();
  },
  requireAdmin({ allowTheatreAdmin: true }),
  (req, res, next) => {
    console.log("✅ requireAdmin() passed for POST /api/showtimes");
    next();
  },
  async (req, res) => {
    console.log(
      "🔥 ENTER handler for POST /api/showtimes body:",
      req.body,
      "user:",
      req.user
    );

    try {
      const movieRaw = req.body.movie ?? req.body.movieId;
      const theaterRaw =
        req.body.theater ?? req.body.theaterId ?? req.body.theatreId;
      const screenRaw = req.body.screen ?? req.body.screenId;
      const startTime = req.body.startTime ?? req.body.startAt;
      const basePrice =
        req.body.basePrice ?? req.body.price ?? req.body.amount;
      const dynamicPricing = req.body.dynamicPricing;

      if (!movieRaw || !theaterRaw || !screenRaw || !startTime || basePrice == null) {
        console.warn(
          "⚠️ POST /api/showtimes missing fields:",
          JSON.stringify(req.body)
        );
        return res.status(400).json({
          message:
            "movie, theater, screen, startTime, basePrice are required",
        });
      }

      console.log("[ID-DEBUG raw]", {
        movieRaw,
        theaterRaw,
        screenRaw,
        movieType: typeof movieRaw,
        theaterType: typeof theaterRaw,
        screenType: typeof screenRaw,
      });

      const movieValid = isId(movieRaw);
      const theaterValid = isId(theaterRaw);
      const screenValid = isId(screenRaw);

      console.log("[ID-DEBUG valid?]", {
        movieValid,
        theaterValid,
        screenValid,
      });

      if (!movieValid || !theaterValid || !screenValid) {
        console.warn(
          "⚠️ POST /api/showtimes invalid id format (shape check failed):",
          "movieRaw:",
          movieRaw,
          "theaterRaw:",
          theaterRaw,
          "screenRaw:",
          screenRaw
        );
        return res
          .status(400)
          .json({ message: "Invalid movie/theater/screen id format" });
      }

      let movieId = safeObjectId(movieRaw);
      let theaterId = safeObjectId(theaterRaw);
      let screenId = safeObjectId(screenRaw);

      console.log("[ID-DEBUG safeObjectId result]", {
        movieId,
        theaterId,
        screenId,
      });

      if (!movieId) {
        movieId = new mongoose.Types.ObjectId(String(movieRaw).trim());
      }
      if (!theaterId) {
        theaterId = new mongoose.Types.ObjectId(String(theaterRaw).trim());
      }
      if (!screenId) {
        screenId = new mongoose.Types.ObjectId(String(screenRaw).trim());
      }

      const [m, t] = await Promise.all([
        Movie.findById(movieId).select("_id").lean(),
        Theater.findById(theaterId).select("_id city").lean(),
      ]);

      const screenDoc = await mongoose
        .model("Screen")
        .findById(screenId)
        .select("_id theater")
        .lean();

      if (!m || !t || !screenDoc) {
        console.warn(
          "⚠️ POST /api/showtimes invalid refs: movie?",
          !!m,
          "theater?",
          !!t,
          "screen?",
          !!screenDoc
        );
        return res
          .status(400)
          .json({ message: "Invalid movie/theater/screen" });
      }

      if (screenDoc.theater && String(screenDoc.theater) !== String(t._id)) {
        return res.status(400).json({
          message: "Screen does not belong to the selected theater",
        });
      }

      try {
        assertInScopeOrThrow(t._id, req);
      } catch (scopeErr) {
        console.error(
          "❌ Scope check failed in POST /api/showtimes:",
          scopeErr?.message || scopeErr
        );
        const code = Number(scopeErr?.status) || 403;
        return res
          .status(code)
          .json({ message: scopeErr.message || "Scope violation" });
      }

      const when = new Date(startTime);
      if (Number.isNaN(when.getTime())) {
        console.warn(
          "⚠️ POST /api/showtimes invalid startTime:",
          startTime
        );
        return res.status(400).json({ message: "Invalid startTime" });
      }
      when.setSeconds(0, 0);

      const doc = await Showtime.create({
        movie: movieId,
        theater: t._id,
        screen: screenId,
        city: t.city,
        startTime: when,
        basePrice: Number(basePrice),
        dynamicPricing: Boolean(dynamicPricing),
      });

      await ensureSeatsInitialized(doc);

      const populated = await Showtime.findById(doc._id)
        .populate(
          "movie",
          "title posterUrl runtime languages censorRating genres"
        )
        .populate("theater", "name city address")
        .populate("screen", "name rows cols format")
        .lean();

      console.log("✅ POST /api/showtimes created:", String(doc._id));

      return res.status(201).json(toDto(populated));
    } catch (e) {
      if (e?.name === "CastError") {
        console.error("❌ CastError in POST /api/showtimes:", e);
        return res.status(400).json({
          message: "Invalid id format for movie/theater/screen",
        });
      }

      if (e?.name === "ValidationError") {
        console.error(
          "❌ ValidationError in POST /api/showtimes:",
          e.message
        );
        return res.status(400).json({
          message: "Validation failed when creating showtime",
          error: e.message,
        });
      }

      if (e?.code === 11000) {
        console.warn("⚠️ Duplicate showtime in POST /api/showtimes:", e);
        return res.status(409).json({
          message: "Showtime already exists for this screen & minute",
        });
      }

      const code = Number(e?.status) || 500;
      console.error("❌ POST /showtimes error:", e);
      return res.status(code).json({
        message: "Failed to create showtime",
        error: e.message,
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* UPDATE: PATCH /api/showtimes/:id (scoped)                                  */
/* -------------------------------------------------------------------------- */
router.patch(
  "/:id",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  async (req, res) => {
    try {
      const id = String(req.params.id);
      if (!isId(id))
        return res.status(400).json({ message: "Invalid showtime id" });

      const doc = await Showtime.findById(id).populate("theater", "_id city");
      if (!doc)
        return res.status(404).json({ message: "Showtime not found" });

      assertInScopeOrThrow(doc.theater?._id || doc.theater, req);

      if (
        req.body.theater &&
        String(req.body.theater) !== String(doc.theater?._id || doc.theater)
      ) {
        return res
          .status(400)
          .json({ message: "Cannot change theater via update" });
      }
      if (
        req.body.screen &&
        String(req.body.screen) !== String(doc.screen)
      ) {
        return res
          .status(400)
          .json({ message: "Cannot change screen via update" });
      }

      const newStart = req.body.startTime ?? req.body.startAt;
      const newPrice =
        req.body.basePrice ?? req.body.price ?? req.body.amount;

      if (newStart !== undefined) {
        const d = new Date(newStart);
        if (Number.isNaN(d.getTime()))
          return res.status(400).json({ message: "Invalid startTime" });
        d.setSeconds(0, 0);
        doc.startTime = d;
      }
      if (newPrice != null) doc.basePrice = Number(newPrice);
      if (typeof req.body.dynamicPricing === "boolean")
        doc.dynamicPricing = req.body.dynamicPricing;

      await doc.save();

      const populated = await Showtime.findById(doc._id)
        .populate(
          "movie",
          "title posterUrl runtime languages censorRating genres"
        )
        .populate("theater", "name city address")
        .populate("screen", "name rows cols format")
        .lean();

      console.log("✅ PATCH /api/showtimes/:id updated:", String(doc._id));

      return res.json(toDto(populated));
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({
          message:
            "Another showtime already exists at that minute on this screen",
        });
      }
      const code = Number(e?.status) || 500;
      console.error("❌ PATCH /showtimes/:id error:", e);
      return res.status(code).json({
        message: "Failed to update showtime",
        error: e.message,
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* DELETE: DELETE /api/showtimes/:id (scoped, theatre-aware)                  */
/* -------------------------------------------------------------------------- */
router.delete(
  "/:id",
  requireAuth(),
  requireAdmin({ allowTheatreAdmin: true }),
  async (req, res) => {
    try {
      const id = String(req.params.id);
      if (!isId(id))
        return res.status(400).json({ message: "Invalid showtime id" });

      const doc = await Showtime.findById(id).populate("theater", "_id");
      if (!doc)
        return res.status(404).json({ message: "Showtime not found" });

      // Try to resolve theatre id from multiple possible fields
      const theatreFromDoc =
        doc.theater?._id ||
        doc.theater ||
        doc.theatreId ||
        doc.theaterId ||
        null;

      // If we can resolve theatre id, enforce scope with it
      if (theatreFromDoc) {
        assertInScopeOrThrow(theatreFromDoc, req);
      } else {
        // Fallback: if there's no theatre on doc but user is theatre admin,
        // deny; SUPER_ADMIN can still proceed.
        const role = String(req.user?.role || "").toUpperCase();
        if (role !== "SUPER_ADMIN") {
          return res.status(403).json({
            message: "Showtime has no theatre bound; only SUPER_ADMIN can delete it",
          });
        }
      }

      await Showtime.findByIdAndDelete(doc._id);
      await SeatLock.deleteMany({
        showtime: doc._id,
        status: { $in: ["HELD", "PENDING"] },
      });

      console.log("🗑️ DELETE /api/showtimes/:id removed:", String(doc._id));

      return res.json({ ok: true });
    } catch (e) {
      const code = Number(e?.status) || 500;
      console.error("❌ DELETE /showtimes/:id error:", e);
      return res.status(code).json({
        message: "Failed to delete showtime",
        error: e.message,
      });
    }
  }
);

export default router;
