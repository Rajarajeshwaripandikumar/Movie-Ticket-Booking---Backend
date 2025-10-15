import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import User from "../models/User.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                           Require authentication                           */
/* -------------------------------------------------------------------------- */
router.use(requireAuth);

/* -------------------------------------------------------------------------- */
/*                            Shared route handlers                           */
/* -------------------------------------------------------------------------- */

// ---------- GET profile handler ----------
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

// ---------- PUT profile handler ----------
const updateProfile = async (req, res) => {
  try {
    const uid = req.user?._id || req.user?.id || req.user?.sub;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const { name, phone, preferences } = req.body || {};
    const updates = {};
    if (typeof name === "string") updates.name = name.trim();
    if (typeof phone === "string") updates.phone = phone.trim();
    if (preferences && typeof preferences === "object") updates.preferences = preferences;

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

// ✅ Support both `/api/profile` and `/api/profile/me`
router.get("/", getProfile);
router.get("/me", getProfile);

router.put("/", updateProfile);
router.put("/me", updateProfile);

/* -------------------------------------------------------------------------- */
/*                             Booking management                             */
/* -------------------------------------------------------------------------- */

// ✅ POST /api/profile/bookings → append booking history
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

    await User.findByIdAndUpdate(uid, { $push: { bookings: normalized } });

    res.status(201).json({
      message: "Added to booking history",
      booking: normalized,
    });
  } catch (err) {
    console.error("[Profile] POST /bookings error:", err);
    res.status(500).json({ message: "Failed to add booking" });
  }
});

// ✅ GET /api/profile/bookings → return user bookings
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

// ✅ POST /api/profile/change-password
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

export default router;
