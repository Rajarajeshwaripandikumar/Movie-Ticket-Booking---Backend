// backend/src/socket/sse.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import debugFactory from "debug";
const debug = debugFactory("app:sse");

const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_SECRET_BASE64 || "dev_jwt_secret_change_me";
const APP_ORIGIN = process.env.APP_ORIGIN || "*";
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);
const MAX_CLIENTS_PER_USER = parseInt(process.env.SSE_MAX_CLIENTS_PER_USER || "8", 10);

function sseWriteRaw(res, str) {
  try {
    if (!res || res.writableEnded || res.destroyed) return false;
    res.write(str);
    return true;
  } catch {
    return false;
  }
}
function sseWrite(res, { event, id, data }) {
  if (!res || res.writableEnded || res.destroyed) return false;
  if (event) sseWriteRaw(res, `event: ${event}\n`);
  if (id) sseWriteRaw(res, `id: ${id}\n`);
  try { sseWriteRaw(res, `data: ${JSON.stringify(data)}\n\n`); } catch (e) { sseWriteRaw(res, `data: ${JSON.stringify({ error: "stringify_failed", raw: String(data) })}\n\n`); }
  return true;
}
function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function extractToken(req) {
  const authHeader = req.headers.authorization || "";
  const cookies = parseCookie(req.headers.cookie || "");
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token && req.query && typeof req.query.token === "string") token = req.query.token;
  if (!token && cookies.token) token = cookies.token;
  if (!token && cookies.access_token) token = cookies.access_token;
  if (!token && cookies.jwt) token = cookies.jwt;
  return { token: token ? String(token) : null, authHeader, cookies };
}
function sanitizeToken(raw) {
  if (!raw || typeof raw !== "string") return null;
  let t = raw.trim();
  try { t = decodeURIComponent(t); } catch {}
  t = t.replace(/:\d+$/, "");
  if ((t.match(/\./g) || []).length !== 2) return null;
  return t;
}
function roleFromDecoded(decoded) {
  const r = decoded?.role || (Array.isArray(decoded?.roles) && decoded.roles.find((x) => String(x).toUpperCase().includes("ADMIN"))) || decoded?.roleName || "USER";
  return String(r).toUpperCase().includes("ADMIN") ? "ADMIN" : "USER";
}

global.sseClients = global.sseClients || new Map();

export const ssePreflight = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, last-event-id");
  res.status(204).end();
};

export const sseHandler = async (req, res) => {
  try {
    const { token: rawToken, cookies } = extractToken(req);
    const token = sanitizeToken(rawToken);

    debug("SSE attempt", { url: req.originalUrl, tokenPresent: Boolean(token), cookieKeys: Object.keys(cookies) });

    if (!token) {
      res.status(401).type("text").send("Unauthorized: missing token (use ?token= or Bearer header or cookie)");
      return;
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"], ignoreExpiration: false });
    } catch (err) {
      debug("Invalid JWT for SSE:", err && err.message);
      res.status(401).type("text").send(`Unauthorized: invalid token (${err && err.name})`);
      return;
    }

    const userId = String(decoded._id || decoded.id || decoded.userId || decoded.sub || "");
    if (!userId) {
      debug("JWT missing user id/payload", decoded);
      res.status(401).type("text").send("Unauthorized: token missing user id");
      return;
    }

    const role = roleFromDecoded(decoded);
    const isAdmin = role === "ADMIN";
    const scope = String(req.query?.scope || "user").toLowerCase();
    const channel = isAdmin && scope === "admin" ? "admin" : userId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.write("retry: 10000\n\n");
    res.flushHeaders?.();

    const current = global.sseClients.get(channel) || new Set();
    if (current.size >= MAX_CLIENTS_PER_USER) {
      sseWrite(res, { event: "error", data: { message: "too_many_connections" } });
      return res.end();
    }

    current.add(res);
    global.sseClients.set(channel, current);
    debug(`SSE connected channel=${channel} clients=${current.size}`);

    res._isSseAlive = () => !res.writableEnded && !res.destroyed;

    sseWrite(res, { event: "connected", data: { channel, role, ts: Date.now() } });

    // Try to load Notification model if exists
    let Notification = null;
    try {
      Notification = mongoose.models.Notification || (await import("../models/Notification.js").then((m) => m.default)).model || mongoose.model("Notification");
    } catch { Notification = null; }
    if (Notification) {
      try {
        const limit = Math.min(Number(req.query?.limit) || 20, 100);
        const or = channel === "admin" ? [{ audience: "ADMIN" }, { audience: "ALL" }] : [{ user: userId }, { audience: "ALL" }];
        const initial = await Notification.find({ $or: or }).sort({ createdAt: -1 }).limit(limit).lean();
        sseWrite(res, { event: "init", data: { notifications: initial } });
      } catch (err) {
        sseWrite(res, { event: "error", data: { message: "init_failed" } });
      }
    } else {
      sseWrite(res, { event: "init", data: { message: "init_ok", notificationsModel: false } });
    }

    const ping = setInterval(() => {
      if (!res._isSseAlive()) return;
      sseWriteRaw(res, `: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(ping);
      const bucket = global.sseClients.get(channel);
      if (bucket) { bucket.delete(res); if (bucket.size === 0) global.sseClients.delete(channel); }
      debug(`SSE disconnected channel=${channel} remaining=${global.sseClients.get(channel)?.size ?? 0}`);
    };

    req.on("close", cleanup);
    req.on("end", cleanup);
    res.on("error", (err) => { debug("SSE socket error", err && err.message); cleanup(); });

    return;
  } catch (err) {
    debug("sseHandler error", err && err.message);
    if (!res.headersSent) res.status(500).json({ message: "SSE failed" });
  }
};

function pushToChannel(channelKey, payload, { eventName } = {}) {
  const set = global.sseClients.get(String(channelKey));
  if (!set || set.size === 0) return 0;
  const event = eventName || (payload && payload.type ? payload.type : "message");
  const id = payload && (payload._id || payload.id) ? String(payload._id || payload.id) : undefined;
  let delivered = 0;
  for (const res of Array.from(set)) {
    try {
      const ok = sseWrite(res, { event, id, data: payload });
      if (!ok) { set.delete(res); continue; }
      delivered++;
    } catch {
      set.delete(res);
    }
  }
  if (set.size === 0) global.sseClients.delete(String(channelKey));
  return delivered;
}
export const pushToUser = (userId, payload, opts = {}) => pushToChannel(String(userId), payload, opts);
export const pushToAdmins = (payload, opts = {}) => pushToChannel("admin", payload, opts);

export const pushNotification = (doc) => {
  if (!doc) return 0;
  const payload = doc.toObject ? doc.toObject() : doc;
  if (payload.audience === "ADMIN") return pushToAdmins(payload, { eventName: "notification" });
  if (payload.audience === "ALL") {
    let n = 0;
    n += pushToAdmins(payload, { eventName: "notification" });
    if (payload.user) n += pushToUser(String(payload.user), payload, { eventName: "notification" });
    return n;
  }
  if (payload.user) return pushToUser(String(payload.user), payload, { eventName: "notification" });
  return 0;
};

export async function emitAnalyticsSnapshot(options = {}) {
  try {
    let Booking = mongoose.models.Booking;
    let Showtime = mongoose.models.Showtime;
    let Theater = mongoose.models.Theater;
    let Movie = mongoose.models.Movie;
    if (!Booking) Booking = mongoose.model("Booking", new mongoose.Schema({}, { strict: false, timestamps: true }));
    if (!Showtime) Showtime = mongoose.model("Showtime", new mongoose.Schema({}, { strict: false, timestamps: true }));
    if (!Theater) Theater = mongoose.model("Theater", new mongoose.Schema({}, { strict: false, timestamps: true }));
    if (!Movie) Movie = mongoose.model("Movie", new mongoose.Schema({}, { strict: false, timestamps: true }));

    const days = Number(options.days || 30);
    const since = new Date(Date.now() - days * 864e5);

    const AMOUNT_SAFE = {
      $ifNull: [
        {
          $switch: {
            branches: [{ case: { $isNumber: "$totalAmount" }, then: "$totalAmount" }, { case: { $isNumber: "$amount" }, then: "$amount" }],
            default: { $toDouble: { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] } },
          },
        },
        0,
      ],
    };

    const dayProject = [{ $addFields: { _d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } }];

    const revenue = await Booking.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] } } },
      ...dayProject,
      { $addFields: { __amount_safe: AMOUNT_SAFE } },
      { $group: { _id: "$_d", totalRevenue: { $sum: "$__amount_safe" }, bookings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: "$_id", totalRevenue: 1, bookings: 1, _id: 0 } },
    ]).catch((e) => { debug("revenue aggregate failed", e && e.message); return []; });

    const users = await Booking.aggregate([
      { $match: { createdAt: { $gte: since } } },
      ...dayProject,
      { $group: { _id: "$_d", users: { $addToSet: { $ifNull: ["$user", "$userId"] } } } },
      { $project: { date: "$_id", dau: { $size: "$users" }, _id: 0 } },
      { $sort: { date: 1 } },
    ]).catch((e) => { debug("users aggregate failed", e && e.message); return []; });

    const occupancy = await Showtime.aggregate([
      { $match: { startTime: { $gte: since } } },
      { $lookup: { from: "bookings", localField: "_id", foreignField: "showtime", as: "bks" } },
      { $project: { theater: 1, totalSeats: { $size: { $ifNull: ["$seats", []] } }, booked: { $sum: { $map: { input: "$bks", as: "b", in: { $size: { $ifNull: ["$$b.seats", { $ifNull: ["$$b.seatsBooked", []] }] } } } } } } },
      { $lookup: { from: "theaters", localField: "theater", foreignField: "_id", as: "t" } },
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$t.name", avgOccupancy: { $avg: { $cond: [{ $gt: ["$totalSeats", 0] }, { $divide: ["$booked", "$totalSeats"] }, 0] } } } },
      { $project: { theaterName: "$_id", avgOccupancy: 1, _id: 0 } },
      { $sort: { avgOccupancy: -1 } },
    ]).catch((e) => { debug("occupancy aggregate failed", e && e.message); return []; });

    const popularMovies = await Booking.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["CONFIRMED", "PAID"] } } },
      { $group: { _id: { $ifNull: ["$movie", "$movieId"] }, bookings: { $sum: 1 }, revenue: { $sum: AMOUNT_SAFE } } },
      { $sort: { bookings: -1 } },
      { $limit: 8 },
      { $lookup: { from: "movies", let: { mid: "$_id" }, pipeline: [ { $match: { $expr: { $or: [ { $eq: ["$_id", "$$mid"] }, { $eq: [{ $toString: "$_id" }, "$$mid"] } ] } } }, { $project: { title: 1 } } ], as: "movie" } },
      { $unwind: { path: "$movie", preserveNullAndEmptyArrays: true } },
      { $project: { movie: { $ifNull: ["$movie.title", "Unknown"] }, bookings: 1, revenue: 1 } },
    ]).catch((e) => { debug("popularMovies aggregate failed", e && e.message); return []; });

    const snapshot = { revenueDaily: revenue, dauDaily: users, occupancy, movies: popularMovies, debug: { emittedAt: new Date().toISOString(), days } };
    const delivered = pushToChannel("admin", snapshot, { eventName: "snapshot" });
    debug(`emitAnalyticsSnapshot delivered=${delivered}`);
    return delivered;
  } catch (err) {
    debug("emitAnalyticsSnapshot error", err && err.message);
    const d = pushToChannel("admin", { message: "snapshot_failed", error: err && err.message, ts: Date.now() }, { eventName: "snapshot" });
    return d;
  }
}

export function startBookingWatcher() {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) { debug("startBookingWatcher: mongoose not connected"); return; }
    const BookingColl = mongoose.connection.collection("bookings");
    if (!BookingColl || !BookingColl.watch) { debug("startBookingWatcher: change streams not supported"); return; }
    const pipeline = [{ $match: { operationType: "insert" } }];
    const stream = BookingColl.watch(pipeline, { fullDocument: "updateLookup" });
    stream.on("change", (change) => {
      try {
        if (change.operationType === "insert") {
          const doc = change.fullDocument || change;
          const total = Number(doc.totalAmount ?? doc.amount ?? 0);
          const seats = (doc.seats || doc.seatsBooked || []).length || 1;
          const dayISO = doc.createdAt ? new Date(doc.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
          const payload = { dayISO, revenueDelta: Number(total), bookingsDelta: 1, bookingId: String(doc._1d || doc._id), bookingSummary: { user: doc.user, movie: doc.movie, seats, totalAmount: Number(total) }, ts: Date.now() };
          pushToAdmins(payload, { eventName: "revenue" });
          pushToAdmins({ revenueDelta: payload.revenueDelta, bookingsDelta: 1, dayISO }, { eventName: "summary" });
          debug("Booking watcher published deltas", payload.bookingId);
        }
      } catch (err) { debug("booking watcher error", err && err.message); }
    });
    stream.on("error", (err) => { debug("booking change stream error", err && err.message); try { stream.close(); } catch {} });
    debug("Booking change stream started");
    return stream;
  } catch (err) { debug("startBookingWatcher failed", err && err.message); return null; }
}

export default { sseHandler, ssePreflight, pushToUser, pushToAdmins, pushNotification, emitAnalyticsSnapshot, startBookingWatcher };
