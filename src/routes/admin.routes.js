// routes/admin.routes.js — FULL MERGED (drop-in) with aliases and resilient endpoints
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import {
  requireAuth,
  requireRoles,
  requireTheatreOwnership,
} from "../middleware/auth.js";

import User from "../models/User.js";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";
import Showtime from "../models/Showtime.js";
import Booking from "../models/Booking.js";
import moviesRouter from "./movies.routes.js";

const router = Router();
router.routesPrefix = "/api/admin"; // ensure mounted at /api/admin
const isId = (id) => mongoose.isValidObjectId(id);

const ADMIN_ROLES = ["SUPER_ADMIN", "THEATRE_ADMIN", "THEATER_ADMIN"];

/* ------------------------- Helper: unified theatre list ------------------------- */
async function handleListTheatres(req, res) {
  try {
    const wantAll = String(req.query.all || "").toLowerCase() === "true";

    // SUPER_ADMIN gets everything (and can request all with ?all=true)
    if (req.user.role === "SUPER_ADMIN") {
      const all = await Theater.find({}).sort({ createdAt: -1 }).lean();
      return res.json(all);
    }

    // Theatre admin -> return only their theatre (as array for frontend compatibility)
    const theatreId = req.user.theatreId;
    if (!theatreId || !isId(theatreId)) {
      return res
        .status(422)
        .json({ message: "This admin is not linked to any theatre (missing theatreId)" });
    }

    const own = await Theater.find({ _id: theatreId }).lean();
    return res.json(own);
  } catch (err) {
    console.error("handleListTheatres error:", err);
    res.status(500).json({ message: "Failed to load theatres" });
  }
}

/* ------------------------- DEBUG / USER PROFILE -------------------------- */
router.get("/debug/me", requireAuth, (req, res) => res.json({ user: req.user }));

router.get("/me", requireAuth, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const id = req.user?._id || req.user?.sub;
    if (!id) return res.status(401).json({ message: "Unauthenticated" });

    const doc = await User.findById(id).lean();
    if (!doc) return res.status(404).json({ message: "Admin not found" });

    const { _id, email, role, name, phone, createdAt, updatedAt } = doc;
    res.json({ id: _id, email, role, name, phone, createdAt, updatedAt });
  } catch (err) {
    console.error("[Admin] /me error:", err);
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});

/* ------------------------------ MOVIES CRUD ------------------------------ */
/* mount canonical movies router (keeps existing behavior) */
router.use("/movies", requireAuth, requireRoles(...ADMIN_ROLES), moviesRouter);

/* ---- MOVIES ALIASES (make frontend candidate endpoints work) ---- */
const movieAliases = [
  "/movies/admin",
  "/movies/admin/list",
  "/movies/list",
  "/movies/mine",
  "/api/movies/admin",
  "/api/movies/admin/list",
  "/api/movies/list",
];

for (const alias of movieAliases) {
  // mount moviesRouter on each alias path with same middlewares
  router.use(alias, requireAuth, requireRoles(...ADMIN_ROLES), moviesRouter);
}

/* --------------------------- THEATRE ADMINS CRUD ------------------------- */
router.get(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (_req, res) => {
    try {
      const admins = await User.find({ role: "THEATRE_ADMIN" })
        .select("_id name email role theatreId createdAt")
        .populate("theatreId", "name city")
        .sort({ createdAt: -1 })
        .lean();

      res.json(
        admins.map((a) => ({
          id: a._id,
          name: a.name,
          email: a.email,
          role: a.role,
          theatre: a.theatreId
            ? { id: a.theatreId._id, name: a.theatreId.name, city: a.theatreId.city }
            : null,
          createdAt: a.createdAt,
        }))
      );
    } catch (e) {
      console.error("theatre-admins error:", e);
      res.status(500).json({ message: "Failed to load theatre admins" });
    }
  }
);

router.post(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { name, email, theatreId, password } = req.body;
      if (!name || !email || !theatreId)
        return res.status(400).json({ message: "name, email, theatreId required" });

      if (!isId(theatreId))
        return res.status(400).json({ message: "Invalid theatreId" });

      const existing = await User.findOne({ email }).lean();
      if (existing) return res.status(409).json({ message: "Email already in use" });

      const hashed = await bcrypt.hash(password || "changeme123", 10);
      const created = await User.create({
        name,
        email: email.toLowerCase().trim(),
        password: hashed,
        role: "THEATRE_ADMIN",
        theatreId,
      });

      const doc = await User.findById(created._id)
        .select("_id name email role theatreId createdAt")
        .populate("theatreId", "name city")
        .lean();

      res.status(201).json({
        id: doc._id,
        name: doc.name,
        email: doc.email,
        role: doc.role,
        theatre: doc.theatreId
          ? { id: doc.theatreId._id, name: doc.theatreId.name, city: doc.theatreId.city }
          : null,
        createdAt: doc.createdAt,
      });
    } catch (e) {
      console.error("create theatre-admin error:", e);
      res.status(500).json({ message: "Failed to create theatre admin" });
    }
  }
);

/* ----------------------------- THEATRES CRUD ----------------------------- */
// Create theatre (super admin)
router.post(
  "/theaters",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { name, city, address } = req.body;
      if (!name || !city) return res.status(400).json({ message: "name and city required" });

      const exists = await Theater.findOne({ name: name.trim(), city: city.trim() }).lean();
      if (exists) return res.status(409).json({ message: "Theatre already exists" });

      const theatre = await Theater.create({ name: name.trim(), city: city.trim(), address: address?.trim() });
      res.status(201).json(theatre);
    } catch (err) {
      console.error("create theater error:", err);
      res.status(500).json({ message: "Failed to create theatre" });
    }
  }
);

// List theatres (role-aware) + supports ?all=true
// Keep original route for backward compatibility
router.get(
  "/theaters",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  handleListTheatres
);

/* ---- THEATRES ALIASES (for frontend trying multiple spellings/paths) ---- */
const theatreAliases = [
  "/theatres",
  "/theater",
  "/theatres/admin/theatres",
  "/theaters/admin/theaters",
  "/theaters/admin/list",
  "/theatres/admin/list",
  "/api/theaters/admin/theaters",
  "/api/theatres/admin/theatres",
  "/theatres/mine",
  "/theaters/mine",
];

for (const alias of theatreAliases) {
  router.get(alias, requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);
}

// Distinct options for dropdowns
router.get(
  "/theaters/options",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const base =
        req.user.role === "SUPER_ADMIN" ? {} :
        (req.user.theatreId && isId(req.user.theatreId)) ? { _id: req.user.theatreId } : {};

      const [names, cities, addresses] = await Promise.all([
        Theater.distinct("name", base),
        Theater.distinct("city", base),
        Theater.distinct("address", base),
      ]);

      res.json({ names, cities, addresses });
    } catch (err) {
      console.error("theaters/options error:", err);
      res.status(500).json({ message: "Failed to load theatre options" });
    }
  }
);

// Single theatre
router.get(
  "/theaters/:id",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const theatre = await Theater.findById(req.params.id).lean();
      if (!theatre) return res.status(404).json({ message: "Theatre not found" });
      res.json(theatre);
    } catch (err) {
      console.error("get theater by id error:", err);
      res.status(500).json({ message: "Failed to load theatre" });
    }
  }
);

/* ------------------------------ SCREENS CRUD ----------------------------- */
router.post(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const { name, rows, cols, columns } = req.body;
      const R = Number(rows);
      const C = Number(cols ?? columns);
      if (!name || !R || !C) return res.status(400).json({ message: "Invalid input" });

      const screen = await Screen.create({
        theater: req.params.id,
        name: String(name).trim(),
        rows: R,
        columns: C,
      });

      res.status(201).json(screen);
    } catch (err) {
      console.error("create screen error:", err);
      res.status(500).json({ message: "Failed to create screen" });
    }
  }
);

router.get(
  "/theaters/:id/screens",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const items = await Screen.find({ theater: req.params.id }).sort({ createdAt: -1 }).lean();
      res.json(items);
    } catch (err) {
      console.error("list screens error:", err);
      res.status(500).json({ message: "Failed to load screens" });
    }
  }
);

/* ---- SCREEN ALIASES (frontend expectations) ---- */
const screenAliases = [
  "/screens/by-theatre/:id",
  "/api/screens/by-theatre/:id",
  "/theatres/:id/screens",
  "/theaters/:id/screen",
];

for (const alias of screenAliases) {
  router.get(
    alias,
    requireAuth,
    requireRoles(...ADMIN_ROLES),
    requireTheatreOwnership,
    async (req, res) => {
      try {
        const id = req.params.id;
        const items = await Screen.find({ theater: id }).lean();
        res.json(items);
      } catch (err) {
        console.error("screen alias error:", err);
        res.status(500).json({ message: "Failed to load screens" });
      }
    }
  );
}

/* ---------------------------- SHOWTIMES / REPORTS ------------------------ */
router.get(
  "/showtimes",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const filter = {};
      if (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") {
        filter.theater = req.user.theatreId;
      }
      const shows = await Showtime.find(filter).populate("movie theater screen").lean();
      res.json(shows);
    } catch (err) {
      console.error("list showtimes error:", err);
      res.status(500).json({ message: "Failed to load showtimes" });
    }
  }
);

/* ---- showtimes/my-theatre alias (frontend uses this) ---- */
router.get(
  "/showtimes/my-theatre",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const theatreId = req.user.theatreId;
      if (!theatreId) return res.json([]);
      const shows = await Showtime.find({ theater: theatreId })
        .populate("movie theater screen")
        .lean();
      res.json(shows);
    } catch (err) {
      console.error("showtimes/my-theatre error:", err);
      res.status(500).json({ message: "Failed to load showtimes" });
    }
  }
);

router.get(
  "/reports",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (_req, res) => {
    try {
      const bookings = await Booking.find()
        .populate({ path: "showtime", populate: ["movie", "theater"] })
        .lean();

      const filtered =
        _req.user.role === "THEATRE_ADMIN" || _req.user.role === "THEATER_ADMIN"
          ? bookings.filter(
              (b) =>
                String(b.showtime?.theater?._id || b.showtime?.theater) ===
                String(_req.user.theatreId)
            )
          : bookings;

      const revenue = filtered.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
      res.json({ count: filtered.length, revenue, bookings: filtered });
    } catch (err) {
      console.error("reports error:", err);
      res.status(500).json({ message: "Failed to generate report" });
    }
  }
);

/* ---------------------------- NOTIFICATIONS (alias) ----------------------- */
/* frontend expects /notifications/mine (nav polls it) — resolve dynamically */
router.get(
  "/notifications/mine",
  requireAuth,
  async (req, res) => {
    try {
      let NotificationModel = null;
      if (mongoose.modelNames().includes("Notification")) {
        NotificationModel = mongoose.model("Notification");
      }

      if (!NotificationModel) {
        // no notification model present — return empty safe shape
        return res.json({ unread: 0, notifications: [] });
      }

      const notifs = await NotificationModel.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
      const unread = notifs.filter(n => !n.readAt).length;
      return res.json({ unread, notifications: notifs });
    } catch (err) {
      console.error("notifications/mine error:", err);
      return res.json({ unread: 0, notifications: [] });
    }
  }
);

/* ---------------------------- Backwards-compatible aliases ----------------- */
/* Some frontends try many variants — return handled responses where possible */

/* Generic alias mapping for theatre-list & movies already added above.
   For convenience, also expose /admin/theaters and /admin/theatres to same handlers. */

router.get("/admin/theaters", requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);
router.get("/admin/theatres", requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);

/* Also accept /theatres/admin/theatres and similar (ensures frontend tries succeed) */
router.get("/theatres/admin/theatres", requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);
router.get("/theaters/admin/theaters", requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);

/* If you prefer to expose plain /theaters (public) for quick testing, we can return all for super-admins
   and a 403 for others. Keep as-is or adjust to your security model. */
router.get("/theaters/public", async (req, res) => {
  try {
    const all = await Theater.find({}).lean();
    res.json(all);
  } catch (err) {
    console.error("theaters/public error:", err);
    res.status(500).json({ message: "Failed to load theatres" });
  }
});

/* ---------------------------- SHOWTIME CRUD & SEATS ------------------------ */
/**
 * Routes added:
 *  POST   /showtimes
 *  PUT    /showtimes/:id
 *  DELETE /showtimes/:id
 *  GET    /screens/:id/showtimes      (admin + aliases)
 *  GET    /showtimes/:id/seats
 *
 * Notes:
 * - Seats are stored inline on the Showtime document as `seats: [{ row, col, status }]`
 * - If rows/cols are not provided on create, we fall back to the referenced Screen's rows/columns.
 * - THEATRE_ADMIN users are restricted to operate on showtimes/screens for their theatre only.
 */

function generateSeats(rows, cols, existingSeats = []) {
  const seats = [];
  // map existing BOOKED seats for preservation when resizing
  const bookedSet = new Set(
    (existingSeats || [])
      .filter((s) => s && s.status === "BOOKED")
      .map((s) => `${s.row}:${s.col}`)
  );

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = `${r}:${c}`;
      seats.push({
        row: r,
        col: c,
        status: bookedSet.has(key) ? "BOOKED" : "AVAILABLE",
      });
    }
  }
  return seats;
}

router.post(
  "/showtimes",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const payload = req.body || {};

      // Accept either screenId or screen
      const screenId = payload.screenId || payload.screen || payload.screen_id;
      if (!screenId || !isId(screenId)) {
        return res.status(400).json({ message: "screenId required" });
      }

      // load screen to derive theatre/rows/cols if needed
      const screen = await Screen.findById(screenId).lean();
      if (!screen) return res.status(404).json({ message: "Screen not found" });

      // Ownership: theatre-admin may only create for their own theatre
      if (
        (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") &&
        String(req.user.theatreId) !== String(screen.theater)
      ) {
        return res.status(403).json({ message: "Not allowed to create showtime for this theatre" });
      }

      const rows = Number(payload.rows ?? payload.R ?? screen.rows ?? 8);
      const cols = Number(payload.cols ?? payload.columns ?? screen.columns ?? 12);

      const showtimeDoc = {
        movie: payload.movie ?? payload.movieId ?? null,
        movieTitle: payload.movieTitle || payload.movie_title || payload.movieName || null,
        theater: payload.theater || payload.theatre || screen.theater,
        screen: screen._id,
        screenId: screen._id,
        startsAt: payload.startsAt ? new Date(payload.startsAt) : payload.startsAt,
        price: payload.price ?? 0,
        rows,
        cols,
        seats: Array.isArray(payload.seats) ? payload.seats : generateSeats(rows, cols, payload.seats),
        meta: payload.meta ?? {},
      };

      const created = await Showtime.create(showtimeDoc);

      const ret = await Showtime.findById(created._id)
        .populate("movie theater screen")
        .lean();

      res.status(201).json(ret);
    } catch (err) {
      console.error("create showtime error:", err);
      res.status(500).json({ message: "Failed to create showtime" });
    }
  }
);

router.put(
  "/showtimes/:id",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!isId(id)) return res.status(400).json({ message: "Invalid showtime id" });

      const existing = await Showtime.findById(id);
      if (!existing) return res.status(404).json({ message: "Showtime not found" });

      // Ownership enforcement for theatre admins
      if (
        (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") &&
        String(req.user.theatreId) !== String(existing.theater)
      ) {
        return res.status(403).json({ message: "Not allowed to edit this showtime" });
      }

      const body = req.body || {};

      // determine new rows/cols if provided (or fall back to existing)
      const newRows = body.rows !== undefined ? Number(body.rows) : existing.rows;
      const newCols = body.cols !== undefined ? Number(body.cols) : existing.cols;

      // If seats were sent explicitly, use them. Otherwise, if grid size changed, regenerate preserving BOOKED seats.
      let newSeats = null;
      if (Array.isArray(body.seats)) {
        newSeats = body.seats;
      } else if (newRows !== existing.rows || newCols !== existing.cols) {
        // preserve BOOKED seats where within bounds
        newSeats = generateSeats(newRows, newCols, existing.seats || []);
      } else {
        // leave as-is (no change)
        newSeats = existing.seats;
      }

      // build update object
      const update = {
        movie: body.movie ?? existing.movie,
        movieTitle: body.movieTitle ?? existing.movieTitle,
        startsAt: body.startsAt ? new Date(body.startsAt) : existing.startsAt,
        price: body.price !== undefined ? body.price : existing.price,
        rows: newRows,
        cols: newCols,
        seats: newSeats,
        updatedAt: new Date(),
      };

      // If screen is being changed, validate screen and theatre ownership
      if (body.screenId || body.screen) {
        const sId = body.screenId || body.screen;
        if (!isId(sId)) return res.status(400).json({ message: "Invalid screen id" });
        const screen = await Screen.findById(sId).lean();
        if (!screen) return res.status(404).json({ message: "Screen not found" });
        // ensure theatre-admin cannot assign to another theatre
        if (
          (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") &&
          String(req.user.theatreId) !== String(screen.theater)
        ) {
          return res.status(403).json({ message: "Not allowed to assign showtime to that screen" });
        }

        update.screen = screen._id;
        update.theater = screen.theater;
      }

      await Showtime.findByIdAndUpdate(id, update, { new: true });

      const ret = await Showtime.findById(id).populate("movie theater screen").lean();
      res.json(ret);
    } catch (err) {
      console.error("update showtime error:", err);
      res.status(500).json({ message: "Failed to update showtime" });
    }
  }
);

router.delete(
  "/showtimes/:id",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!isId(id)) return res.status(400).json({ message: "Invalid showtime id" });

      const existing = await Showtime.findById(id).lean();
      if (!existing) return res.status(404).json({ message: "Showtime not found" });

      if (
        (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") &&
        String(req.user.theatreId) !== String(existing.theater)
      ) {
        return res.status(403).json({ message: "Not allowed to delete this showtime" });
      }

      await Showtime.findByIdAndDelete(id);
      res.json({ message: "Deleted" });
    } catch (err) {
      console.error("delete showtime error:", err);
      res.status(500).json({ message: "Failed to delete showtime" });
    }
  }
);

/* ------------------- List showtimes by screen (admin-facing) --------------- */
router.get(
  "/screens/:id/showtimes",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  requireTheatreOwnership,
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!isId(id)) return res.status(400).json({ message: "Invalid screen id" });

      const items = await Showtime.find({ screen: id }).populate("movie theater screen").sort({ startsAt: 1 }).lean();
      res.json(items);
    } catch (err) {
      console.error("screens/:id/showtimes error:", err);
      res.status(500).json({ message: "Failed to load showtimes for screen" });
    }
  }
);

/* ---- Backwards-compatible aliases for screen showtimes ---- */
const showtimeScreenAliases = [
  "/screens/:id/showtimes",
  "/api/screens/:id/showtimes",
  "/theatres/:id/showtimes",
  "/theaters/:id/showtimes",
  "/admin/screens/:id/showtimes",
];

for (const alias of showtimeScreenAliases) {
  router.get(
    alias,
    requireAuth,
    requireRoles(...ADMIN_ROLES),
    requireTheatreOwnership,
    async (req, res) => {
      try {
        const id = req.params.id;
        if (!isId(id)) return res.status(400).json({ message: "Invalid screen id" });
        const items = await Showtime.find({ screen: id }).populate("movie theater screen").lean();
        res.json(items);
      } catch (err) {
        console.error("showtime alias error:", err);
        res.status(500).json({ message: "Failed to load showtimes" });
      }
    }
  );
}

/* -------------------------- Seats endpoint ------------------------------- */
router.get(
  "/showtimes/:id/seats",
  requireAuth,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!isId(id)) return res.status(400).json({ message: "Invalid showtime id" });

      const st = await Showtime.findById(id).lean();
      if (!st) return res.status(404).json({ message: "Showtime not found" });

      // theatre-admin protection: only allow if admin owns the theatre
      if (
        (req.user.role === "THEATRE_ADMIN" || req.user.role === "THEATER_ADMIN") &&
        String(req.user.theatreId) !== String(st.theater)
      ) {
        return res.status(403).json({ message: "Not allowed to view seats for this showtime" });
      }

      const rows = st.rows || st.R || 8;
      const cols = st.cols || st.columns || 12;

      const seats = Array.isArray(st.seats) && st.seats.length
        ? st.seats
        : generateSeats(rows, cols, []);

      return res.json({ id: st._id, rows, cols, seats });
    } catch (err) {
      console.error("showtime seats error:", err);
      res.status(500).json({ message: "Failed to load seats" });
    }
  }
);

/* ---------------------------- Backwards-compatible aliases ----------------- */
/* Some frontends try many variants — return handled responses where possible */
/* (redundant aliases above already cover many cases; keep these for extra resilience) */

router.get("/admin/theaters", requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);
router.get("/admin/theatres", requireAuth, requireRoles(...ADMIN_ROLES), handleListTheatres);

/* ---------------------------- Export router ------------------------------- */
export default router;
