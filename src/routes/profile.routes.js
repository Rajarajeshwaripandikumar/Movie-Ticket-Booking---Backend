// backend/src/routes/profile.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import User from "../models/User.js";
import Theater from "../models/Theater.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";

const router = Router();

/* ---------------------------- role helpers ---------------------------- */
function isSuperAdmin(req) {
  return String(req.user?.role || "").toUpperCase() === "SUPER_ADMIN";
}
function isAdmin(req) {
  const r = String(req.user?.role || "").toUpperCase();
  return r === "ADMIN" || r === "SUPER_ADMIN";
}
function isTheatreAdmin(req) {
  return String(req.user?.role || "").toUpperCase() === "THEATRE_ADMIN";
}

/* -------------------------------------------------------------------------- */
/*                           Require authentication                           */
/* -------------------------------------------------------------------------- */
router.use(requireAuth);

/* -------------------------------------------------------------------------- */
/*                            Shared route handlers                           */
/* -------------------------------------------------------------------------- */

const getProfile = async (req, res) => {
  try {
    const uid = req.user?._id || req.user?.id || req.user?.sub;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const user = await User.findById(uid).select(
      "-password -resetPasswordToken -resetPasswordExpires"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const safeUser = user.toObject();
    safeUser.preferences ??= { language: "en", notifications: { email: true, sms: false } };
    safeUser.bookings ??= [];

    res.json({ user: safeUser });
  } catch (err) {
    console.error("[Profile] GET profile error:", err);
    res.status(500).json({ message: "Failed to load profile" });
  }
};

const updateProfile = async (req, res) => {
  try {
    const uid = req.user?._id || req.user?.id || req.user?.sub;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const { name, phone, preferences, email, avatarUrl } = req.body || {};
    const updates = {};
    if (typeof name === "string") updates.name = name.trim();
    if (typeof phone === "string") updates.phone = phone.trim();
    if (preferences && typeof preferences === "object") updates.preferences = preferences;
    if (typeof avatarUrl === "string") updates.avatarUrl = avatarUrl;

    if (typeof email === "string") {
      const e = email.trim().toLowerCase();
      const exists = await User.findOne({ email: e, _id: { $ne: uid } }).lean();
      if (exists) return res.status(409).json({ message: "Email already in use" });
      updates.email = e;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const updatedUser = await User.findByIdAndUpdate(
      uid,
      { $set: updates },
      { new: true, runValidators: true, context: "query" }
    ).select("-password -resetPasswordToken -resetPasswordExpires");

    if (!updatedUser) return res.status(404).json({ message: "User not found" });
    res.json({ user: updatedUser });
  } catch (err) {
    console.error("[Profile] PUT profile error:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
};

/* -------------------------------------------------------------------------- */
/*                             Profile CRUD routes                            */
/* -------------------------------------------------------------------------- */

router.get("/", getProfile);
router.get("/me", getProfile);

router.put("/", updateProfile);
router.put("/me", updateProfile);

/* -------------------------------------------------------------------------- */
/*                             Booking management                             */
/* -------------------------------------------------------------------------- */

router.post("/bookings", async (req, res) => {
  try {
    const uid = req.user?._id || req.user?.id || req.user?.sub;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const booking = req.body?.booking;
    if (!booking || typeof booking !== "object")
      return res.status(400).json({ message: "booking object required" });

    const normalized = {
      bookingId: booking.bookingId || uuidv4(),
      showtimeId: booking.showtimeId || null,
      movieTitle: booking.movieTitle || "Untitled",
      seats: Array.isArray(booking.seats) ? booking.seats.map(String) : [],
      amount: Number(booking.amount) || 0,
      bookedAt: booking.bookedAt ? new Date(booking.bookedAt) : new Date(),
    };

    const updated = await User.findByIdAndUpdate(
      uid,
      { $push: { bookings: normalized } },
      { new: true, select: "bookings" }
    ).lean();

    if (!updated) return res.status(404).json({ message: "User not found" });

    res.status(201).json({
      message: "Added to booking history",
      booking: normalized,
      bookings: updated.bookings || [],
    });
  } catch (err) {
    console.error("[Profile] POST /bookings error:", err);
    res.status(500).json({ message: "Failed to add booking" });
  }
});

router.get("/bookings", async (req, res) => {
  try {
    const uid = req.user?._id || req.user?.id || req.user?.sub;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const user = await User.findById(uid).select("bookings");
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ bookings: user.bookings || [] });
  } catch (err) {
    console.error("[Profile] GET /bookings error:", err);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

/* -------------------------------------------------------------------------- */
/*                          Change password (secured)                         */
/* -------------------------------------------------------------------------- */

router.post("/change-password", async (req, res) => {
  try {
    const uid = req.user?._id || req.user?.id || req.user?.sub;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "Both current and new passwords required" });

    if (newPassword.length < 8)
      return res.status(400).json({ message: "New password must be at least 8 characters long" });

    const user = await User.findById(uid).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch =
      typeof user.compare === "function"
        ? await user.compare(String(currentPassword))
        : await bcrypt.compare(String(currentPassword), user.password);

    if (!isMatch)
      return res.status(400).json({ message: "Current password is incorrect" });

    user.password = newPassword; // triggers pre-save hook (hash)
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("[Profile] POST /change-password error:", err);
    res.status(500).json({ message: "Failed to change password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                            Admin & Theatre Admin APIs                       */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/profile/admin/users
 * - SUPER_ADMIN or ADMIN only
 * - Returns list of users (safe fields)
 */
router.get("/admin/users", async (req, res) => {
  try {
    if (!isAdmin(req) && !isSuperAdmin(req)) return res.status(403).json({ message: "Forbidden" });

    const q = {};
    // optional query filters
    if (req.query.role) q.role = req.query.role;
    if (req.query.email) q.email = String(req.query.email).toLowerCase();

    // theatre-admins shouldn't use this route — only super/admins
    const users = await User.find(q)
      .select("-password -resetPasswordToken -resetPasswordExpires")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ users });
  } catch (err) {
    console.error("[Profile] GET admin/users error:", err);
    res.status(500).json({ message: "Failed to list users" });
  }
});

/**
 * PATCH /api/profile/admin/users/:id
 * - SUPER_ADMIN or ADMIN only
 * - Update role / theatreId / basic profile of another user
 */
router.patch("/admin/users/:id", async (req, res) => {
  try {
    if (!isSuperAdmin(req) && !isAdmin(req)) return res.status(403).json({ message: "Forbidden" });
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: "User id required" });

    const payload = {};
    if (req.body.role) payload.role = req.body.role;
    if (req.body.theatreId) payload.theatreId = req.body.theatreId;
    if (req.body.name) payload.name = req.body.name;
    if (req.body.phone) payload.phone = req.body.phone;
    if (req.body.email) payload.email = String(req.body.email).toLowerCase();

    if (Object.keys(payload).length === 0) return res.status(400).json({ message: "Nothing to update" });

    // If role change to THEATRE_ADMIN, require theatreId
    if (payload.role && String(payload.role).toUpperCase() === "THEATRE_ADMIN" && !payload.theatreId) {
      return res.status(400).json({ message: "theatreId required when assigning THEATRE_ADMIN role" });
    }

    // quick existence check for theatreId
    if (payload.theatreId) {
      const th = await Theater.findById(payload.theatreId).select("_id").lean();
      if (!th) return res.status(400).json({ message: "Invalid theatreId" });
    }

    const updated = await User.findByIdAndUpdate(id, { $set: payload }, { new: true }).select(
      "-password -resetPasswordToken -resetPasswordExpires"
    );

    if (!updated) return res.status(404).json({ message: "User not found" });
    res.json({ user: updated });
  } catch (err) {
    console.error("[Profile] PATCH admin/users/:id error:", err);
    res.status(500).json({ message: "Failed to update user" });
  }
});

/**
 * POST /api/profile/admin/create-theatre-admin
 * - SUPER_ADMIN only: create a THEATRE_ADMIN tied to a theatre
 * - Body: { email, password, name, theatreId, phone }
 */
router.post("/admin/create-theatre-admin", async (req, res) => {
  try {
    if (!isSuperAdmin(req)) return res.status(403).json({ message: "Forbidden" });

    const { email, password, name, theatreId, phone } = req.body || {};
    if (!email || !password || !theatreId) return res.status(400).json({ message: "email,password,theatreId required" });

    const exists = await User.findOne({ email: String(email).toLowerCase() }).lean();
    if (exists) return res.status(409).json({ message: "Email already in use" });

    const t = await Theater.findById(theatreId).select("_id").lean();
    if (!t) return res.status(400).json({ message: "Invalid theatreId" });

    const newUser = new User({
      email: String(email).toLowerCase(),
      password,
      name: name || "",
      phone: phone || "",
      role: "THEATRE_ADMIN",
      theatreId,
    });
    await newUser.save();

    const out = await User.findById(newUser._id).select("-password -resetPasswordToken -resetPasswordExpires").lean();
    res.status(201).json({ user: out });
  } catch (err) {
    console.error("[Profile] POST admin/create-theatre-admin error:", err);
    res.status(500).json({ message: "Failed to create theatre admin" });
  }
});

/**
 * PATCH /api/profile/theatre/set
 * - THEATRE_ADMIN can set/confirm their theatreId (only for themselves)
 * - Body: { theatreId }
 */
router.patch("/theatre/set", async (req, res) => {
  try {
    if (!isTheatreAdmin(req)) return res.status(403).json({ message: "Forbidden" });

    const uid = req.user?._id || req.user?.id || req.user?.sub;
    const { theatreId } = req.body || {};
    if (!theatreId) return res.status(400).json({ message: "theatreId required" });

    const th = await Theater.findById(theatreId).select("_id").lean();
    if (!th) return res.status(400).json({ message: "Invalid theatreId" });

    const updated = await User.findByIdAndUpdate(uid, { $set: { theatreId } }, { new: true }).select(
      "-password -resetPasswordToken -resetPasswordExpires"
    );
    res.json({ user: updated });
  } catch (err) {
    console.error("[Profile] PATCH theatre/set error:", err);
    res.status(500).json({ message: "Failed to set theatre" });
  }
});

/* -------------------------------------------------------------------------- */
/*                            Module metadata                                  */
/* -------------------------------------------------------------------------- */

router.routesPrefix = "/api/profile";
export default router;
