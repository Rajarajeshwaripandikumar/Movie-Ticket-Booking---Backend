// routes/notificationPrefs.routes.js
import { Router } from "express";
import NotificationPref from "../models/NotificationPref.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Keep this in sync with your model fields
const defaultPrefs = {
  bookingConfirmed: { inApp: true, email: true, sms: false, push: false },
  bookingCancelled: { inApp: true, email: true, sms: false, push: false },
  bookingReminder:  { inApp: true, email: true, sms: false, push: false },
  showtimeChanged:  { inApp: true, email: true, sms: false, push: false },
  upcomingMovie:    { inApp: true, email: false, sms: false, push: false },
  timezone: "Asia/Kolkata",
};

const allowedBooleanPaths = new Set([
  "bookingConfirmed.inApp", "bookingConfirmed.email", "bookingConfirmed.sms", "bookingConfirmed.push",
  "bookingCancelled.inApp", "bookingCancelled.email", "bookingCancelled.sms", "bookingCancelled.push",
  "bookingReminder.inApp",  "bookingReminder.email",  "bookingReminder.sms",  "bookingReminder.push",
  "showtimeChanged.inApp",  "showtimeChanged.email",  "showtimeChanged.sms",  "showtimeChanged.push",
  "upcomingMovie.inApp",    "upcomingMovie.email",    "upcomingMovie.sms",    "upcomingMovie.push",
]);

function coerceBoolean(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return Boolean(v);
}

// Flattens nested objects to dot paths, but only keeps whitelisted fields
function toDotSet(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      toDotSet(v, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

// GET /me -> always return a complete object (defaults merged with stored)
router.get("/me", requireAuth, async (req, res) => {
  const doc = await NotificationPref.findOne({ user: req.user._id }).lean();
  const merged = {
    ...defaultPrefs,
    ...(doc ? {
      bookingConfirmed: { ...defaultPrefs.bookingConfirmed, ...(doc.bookingConfirmed || {}) },
      bookingCancelled: { ...defaultPrefs.bookingCancelled, ...(doc.bookingCancelled || {}) },
      bookingReminder:  { ...defaultPrefs.bookingReminder,  ...(doc.bookingReminder  || {}) },
      showtimeChanged:  { ...defaultPrefs.showtimeChanged,  ...(doc.showtimeChanged  || {}) },
      upcomingMovie:    { ...defaultPrefs.upcomingMovie,    ...(doc.upcomingMovie    || {}) },
      timezone: doc.timezone || defaultPrefs.timezone,
    } : {}),
  };
  res.json(merged);
});

// PATCH /me -> partial update, whitelist + coerce booleans, upsert
router.patch("/me", requireAuth, async (req, res) => {
  const flat = toDotSet(req.body);

  const $set = {};
  for (const [path, val] of Object.entries(flat)) {
    if (path === "timezone") {
      // Basic TZ guard (keep it simple; you can validate against IANA DB if you like)
      if (typeof val === "string" && val.trim()) $set.timezone = val.trim();
      continue;
    }
    if (allowedBooleanPaths.has(path)) {
      $set[path] = coerceBoolean(val);
    }
  }

  if (Object.keys($set).length === 0 && !$set.timezone) {
    return res.status(400).json({ message: "No valid fields to update" });
  }

  const pref = await NotificationPref.findOneAndUpdate(
    { user: req.user._id },
    { $set: { user: req.user._id, ...$set } },
    { new: true, upsert: true }
  ).lean();

  // Return the merged view so the frontend always receives a full object
  const merged = {
    ...defaultPrefs,
    bookingConfirmed: { ...defaultPrefs.bookingConfirmed, ...(pref.bookingConfirmed || {}) },
    bookingCancelled: { ...defaultPrefs.bookingCancelled, ...(pref.bookingCancelled || {}) },
    bookingReminder:  { ...defaultPrefs.bookingReminder,  ...(pref.bookingReminder  || {}) },
    showtimeChanged:  { ...defaultPrefs.showtimeChanged,  ...(pref.showtimeChanged  || {}) },
    upcomingMovie:    { ...defaultPrefs.upcomingMovie,    ...(pref.upcomingMovie    || {}) },
    timezone: pref.timezone || defaultPrefs.timezone,
  };

  res.json(merged);
});

export default router;
