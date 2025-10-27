// backend/src/routes/auth.js
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../models/User.js";
import mailer from "../models/mailer.js"; // must export createResetUrl, resetPasswordTemplate, sendEmail

const router = express.Router();

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const TOKEN_SIZE_BYTES = 32;
const RESET_EXPIRES_MS = Number(process.env.RESET_TOKEN_EXPIRES_MINUTES || 60) * 60 * 1000;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign({ sub: user._id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function safeUserPayload(userDoc) {
  if (!userDoc) return null;
  const u = userDoc.toObject ? userDoc.toObject() : userDoc;
  return {
    id: u._id,
    email: u.email,
    name: u.name || "",
    phone: u.phone || "",
    role: u.role || "USER",
    preferences: u.preferences || { language: "en", notifications: { email: true, sms: false } },
    bookings: u.bookings || [],
    createdAt: u.createdAt,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// -----------------------------------------------------------------------------
// REGISTER
// -----------------------------------------------------------------------------
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone, roleParam } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: "Email already registered" });

    const user = new User({
      email: email.toLowerCase(),
      name: name || "",
      phone: phone || "",
      role: roleParam === "ADMIN" ? "ADMIN" : "USER",
      password, // pre-save hook should hash
    });

    await user.save();
    const token = signToken(user);
    res.status(201).json({ message: "Registered successfully", token, user: safeUserPayload(user) });
  } catch (err) {
    console.error("REGISTER_ERROR:", err.message);
    res.status(500).json({ message: "Failed to register" });
  }
});

// -----------------------------------------------------------------------------
// LOGIN
// -----------------------------------------------------------------------------
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!user) return res.status(401).json({ message: "Email not registered" });

    const match = await user.compare(password);
    if (!match) return res.status(401).json({ message: "Incorrect password" });

    if (user.role === "ADMIN") return res.status(403).json({ message: "Please login via /admin/login" });

    const token = signToken(user);
    res.json({ message: "Login successful", token, user: safeUserPayload(user) });
  } catch (err) {
    console.error("LOGIN_ERROR:", err.message);
    res.status(500).json({ message: err.message || "Login failed" });
  }
});

// -----------------------------------------------------------------------------
// ADMIN LOGIN
// -----------------------------------------------------------------------------
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const admin = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!admin || admin.role !== "ADMIN") return res.status(401).json({ message: "Unauthorized — not an admin" });

    const ok = await admin.compare(password);
    if (!ok) return res.status(401).json({ message: "Invalid password" });

    const token = signToken(admin);
    res.json({ message: "Admin login successful", token, user: safeUserPayload(admin) });
  } catch (err) {
    console.error("ADMIN_LOGIN_ERROR:", err.message);
    res.status(500).json({ message: "Admin login failed" });
  }
});

// -----------------------------------------------------------------------------
// ME
// -----------------------------------------------------------------------------
router.get("/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub);
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ user: safeUserPayload(user) });
  } catch (err) {
    console.error("ME_ERROR:", err.message);
    res.status(401).json({ message: "Invalid or expired token" });
  }
});

// -----------------------------------------------------------------------------
// CHANGE PASSWORD (Logged-in user)
// -----------------------------------------------------------------------------
router.post("/change-password", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both current and new passwords required" });

    const match = await user.compare(currentPassword);
    if (!match) return res.status(400).json({ message: "Current password is incorrect" });

    user.password = newPassword;
    await user.save();

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err.message);
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") return res.status(401).json({ message: "Invalid or expired token" });
    res.status(500).json({ message: "Failed to change password" });
  }
});

// -----------------------------------------------------------------------------
// FORGOT PASSWORD — uses mailer (Gmail OAuth) and includes email in link
// -----------------------------------------------------------------------------
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required." });

    const genericMsg = "If that email exists, you'll receive reset instructions.";
    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.json({ message: genericMsg });

    // create token (store hash)
    const token = crypto.randomBytes(TOKEN_SIZE_BYTES).toString("hex");
    const hashedToken = hashToken(token);
    const expires = Date.now() + RESET_EXPIRES_MS;

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(expires);
    await user.save();

    // build reset URL that includes email (frontend expects it)
    const { resetFrontendUrl } = mailer.createResetUrl({ token, userId: user._id, email: normalizedEmail });
    const resetUrl = resetFrontendUrl;

    const html = mailer.resetPasswordTemplate({ name: user.name || user.email, resetUrl, expiresMinutes: Math.round(RESET_EXPIRES_MS / 60000) });

    // send via your mailer (Gmail OAuth)
    const sendRes = await mailer.sendEmail({
      to: normalizedEmail,
      subject: "Reset your password",
      html,
      text: `Reset your password: ${resetUrl} (link expires in ${Math.round(RESET_EXPIRES_MS / 60000)} minutes)`,
    });

    if (!sendRes.ok) console.error("[/forgot-password] mailer failed:", sendRes.error || sendRes);

    return res.json({ message: genericMsg });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err && (err.stack || err));
    return res.status(500).json({ message: "Failed to send reset email." });
  }
});

// -----------------------------------------------------------------------------
// RESET PASSWORD — flexible (accepts password/newPassword, email optional)
// -----------------------------------------------------------------------------
router.post("/reset-password", async (req, res) => {
  try {
    // frontend may send { token, password } or { token, newPassword } or { email, token, newPassword }
    const { token, email } = req.body;
    const newPassword = req.body.newPassword || req.body.password;
    if (!token || !newPassword) return res.status(400).json({ message: "Token and new password required." });
    if (String(newPassword).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });

    const hashedToken = hashToken(String(token));

    // If email provided, prefer stricter lookup by email+token
    let user = null;
    if (email) {
      user = await User.findOne({
        email: String(email).toLowerCase().trim(),
        resetPasswordToken: hashedToken,
        resetPasswordExpires: { $gt: Date.now() },
      }).select("+password");
    } else {
      user = await User.findOne({
        resetPasswordToken: hashedToken,
        resetPasswordExpires: { $gt: Date.now() },
      }).select("+password");
    }

    if (!user) return res.status(400).json({ message: "Invalid or expired token." });

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // optional confirmation email
    try {
      await mailer.sendEmail({
        to: user.email,
        subject: "Your password has been changed",
        html: `<div style="font-family:Arial,Helvetica,sans-serif;"><h3>Password changed</h3><p>Your password for <b>${user.email}</b> was updated. If you did not do this, contact support.</p></div>`,
        text: `Your password for ${user.email} was updated.`,
      });
    } catch (e) {
      console.warn("[/reset-password] confirmation email failed:", e && (e.message || e));
    }

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR:", err && (err.stack || err));
    return res.status(500).json({ message: "Failed to reset password." });
  }
});

export default router;
