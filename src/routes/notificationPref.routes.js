// backend/src/routes/notificationPrefs.routes.js
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

function buildMerged(prefDoc) {
  return {
    bookingConfirmed: { ...defaultPrefs.bookingConfirmed, ...(prefDoc?.bookingConfirmed || {}) },
    bookingCancelled: { ...defaultPrefs.bookingCancelled, ...(prefDoc?.bookingCancelled || {}) },
    bookingReminder:  { ...defaultPrefs.bookingReminder,  ...(prefDoc?.bookingReminder  || {}) },
    showtimeChanged:  { ...defaultPrefs.showtimeChanged,  ...(prefDoc?.showtimeChanged  || {}) },
    upcomingMovie:    { ...defaultPrefs.upcomingMovie,    ...(prefDoc?.upcomingMovie    || {}) },
    timezone: prefDoc?.timezone || defaultPrefs.timezone,
  };
}

/**
 * GET /api/notification-prefs/me
 * Return merged preferences (defaults + stored)
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const pref = await NotificationPref.findOne({ user: req.user._id }).lean();
    const merged = buildMerged(pref);
    return res.json({ ok: true, prefs: merged, raw: pref || null });
  } catch (err) {
    console.error("[NotificationPrefs] GET /me error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load preferences" });
  }
});

/**
 * PATCH /api/notification-prefs/me
 * Partial update, only whitelisted boolean paths + timezone allowed.
 * Upserts a document for the user if missing.
 */
router.patch("/me", requireAuth, async (req, res) => {
  try {
    const flat = toDotSet(req.body || {});
    const $set = {};

    for (const [path, val] of Object.entries(flat)) {
      if (path === "timezone") {
        if (typeof val === "string" && val.trim()) {
          // simple guard — do not accept extremely long strings
          const tz = val.trim();
          if (tz.length > 64) return res.status(400).json({ ok: false, error: "Invalid timezone" });
          $set.timezone = tz;
        }
        continue;
      }

      if (allowedBooleanPaths.has(path)) {
        $set[path] = coerceBoolean(val);
      }
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ ok: false, error: "No valid fields to update" });
    }

    // Build update: ensure the user field exists and merge
    const update = {
      $set: { ...$set, user: req.user._id },
      $setOnInsert: { user: req.user._id, createdAt: new Date() },
    };

    const pref = await NotificationPref.findOneAndUpdate(
      { user: req.user._id },
      update,
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    const merged = buildMerged(pref);
    return res.json({ ok: true, prefs: merged, raw: pref });
  } catch (err) {
    console.error("[NotificationPrefs] PATCH /me error:", err);
    return res.status(500).json({ ok: false, error: "Failed to update preferences" });
  }
});

export default router;
