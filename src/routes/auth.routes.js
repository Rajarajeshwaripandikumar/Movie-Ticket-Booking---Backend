// backend/src/routes/auth.routes.js
import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import User from "../models/User.js";
import mailer from "../models/mailer.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173";
const RESET_EXP_MIN = Number(process.env.RESET_TOKEN_EXPIRY_MIN || 60);

/* --------------------- Helper utilities --------------------- */

function safeUserPayload(userDoc) {
  if (!userDoc) return null;
  // ensure plain object
  const u = typeof userDoc.toJSON === "function" ? userDoc.toJSON() : (userDoc.toObject ? userDoc.toObject() : userDoc);
  return {
    id: u._id,
    email: u.email,
    name: u.name || "",
    phone: u.phone || "",
    role: u.role || "USER",
    theater: u.theater || null,
    preferences: u.preferences || { language: "en", notifications: { email: true, sms: false } },
    bookings: u.bookings || [],
    createdAt: u.createdAt,
  };
}

async function signTokenForUser(user) {
  // prefer model helper if available
  if (typeof user.generateJWT === "function") return user.generateJWT();
  // fallback
  return jwt.sign({ id: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authHeaderToken(req) {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  return token;
}

/* -------------------------- REGISTER ------------------------- */
/**
 * POST /api/auth/register
 * Body: { email, password, name?, phone? }
 * - Always creates role USER by default.
 * - To create THEATER_ADMIN or SUPER_ADMIN use admin flows (not open registration).
 */
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const normalized = String(email).toLowerCase().trim();
    const exists = await User.findOne({ email: normalized }).lean();
    if (exists) return res.status(409).json({ message: "Email already registered" });

    // Create user: set passwordHash so model pre-save will hash it
    const user = new User({
      email: normalized,
      name: name || "",
      phone: phone || "",
      role: "USER",
      passwordHash: String(password),
    });

    await user.save();

    const token = await signTokenForUser(user);
    return res.status(201).json({ message: "Registered successfully", token, user: safeUserPayload(user) });
  } catch (err) {
    console.error("REGISTER_ERROR:", err);
    return res.status(500).json({ message: "Failed to register", error: err.message });
  }
});

/* ---------------------------- LOGIN -------------------------- */
/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const normalized = String(email).toLowerCase().trim();
    // load hashed password
    const user = await User.findOne({ email: normalized }).select("+passwordHash");
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    // prevent admin login via user endpoint if you want explicit admin route
    if (user.role === "SUPER_ADMIN" || user.role === "THEATER_ADMIN") {
      // still allow but warn: prefer /admin/login for admin flows
      // you can change behavior: return 403 to force admin endpoint
    }

    const token = await signTokenForUser(user);
    return res.json({ message: "Login successful", token, user: safeUserPayload(user) });
  } catch (err) {
    console.error("LOGIN_ERROR:", err);
    return res.status(500).json({ message: "Login failed", error: err.message });
  }
});

/* ------------------------ ADMIN LOGIN ------------------------ */
/**
 * POST /api/auth/admin/login
 * Body: { email, password }
 * Accepts THEATER_ADMIN and SUPER_ADMIN
 */
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const normalized = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalized }).select("+passwordHash");
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    if (user.role !== "SUPER_ADMIN" && user.role !== "THEATER_ADMIN") {
      return res.status(403).json({ message: "Unauthorized — not an admin" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = await signTokenForUser(user);
    return res.json({ message: "Admin login successful", token, user: safeUserPayload(user) });
  } catch (err) {
    console.error("ADMIN_LOGIN_ERROR:", err);
    return res.status(500).json({ message: "Admin login failed", error: err.message });
  }
});

/* ----------------------------- /me ---------------------------- */
/**
 * GET /api/auth/me
 * Accepts Authorization: Bearer <token>
 */
router.get("/me", async (req, res) => {
  try {
    const token = authHeaderToken(req);
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded?.id || decoded?.sub || decoded?.userId;
    if (!id) return res.status(401).json({ message: "Invalid token payload" });

    const user = await User.findById(id).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    return res.json({ user: safeUserPayload(user) });
  } catch (err) {
    console.error("ME_ERROR:", err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});

/* ------------------------ CHANGE PASSWORD ---------------------- */
/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Requires Authorization header token
 */
router.post("/change-password", async (req, res) => {
  try {
    const token = authHeaderToken(req);
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded?.id || decoded?.sub;
    if (!id) return res.status(401).json({ message: "Invalid token" });

    const user = await User.findById(id).select("+passwordHash");
    if (!user) return res.status(404).json({ message: "User not found" });

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both current and new passwords required" });
    if (typeof newPassword !== "string" || newPassword.length < 8) return res.status(400).json({ message: "New password must be at least 8 characters" });

    const match = await user.comparePassword(currentPassword);
    if (!match) return res.status(400).json({ message: "Current password is incorrect" });

    user.passwordHash = String(newPassword); // pre-save hook will hash
    await user.save();

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err);
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") return res.status(401).json({ message: "Invalid or expired token" });
    return res.status(500).json({ message: "Failed to change password" });
  }
});

/* ------------------------- FORGOT PASSWORD ---------------------- */
/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Stores hashed token on user and sends email (uses mailer)
 */
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email required" });

    const normalized = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalized });
    // respond success either way (prevent enumeration)
    const generic = { message: "If that email exists, a reset link has been sent" };
    if (!user) return res.json(generic);

    // create token (store hashed token)
    const token = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const expires = new Date(Date.now() + RESET_EXP_MIN * 60 * 1000);

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = expires;
    await user.save();

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;

    const html = `
      <div style="font-family:sans-serif">
        <p>Hello ${user.name || "User"},</p>
        <p>You (or someone else) requested a password reset. Click the link below to reset your password. This link expires in ${RESET_EXP_MIN} minutes.</p>
        <p><a href="${resetUrl}">Reset password</a></p>
        <p>If you did not request this, ignore this email.</p>
      </div>
    `;

    const sent = await mailer.sendEmail({
      to: user.email,
      subject: "Password reset instructions — MovieBook",
      html,
      text: `Reset your password: ${resetUrl}`,
    });

    // in dev the mailer returns previewUrl; reveal in response only if available and NODE_ENV !== 'production'
    const note = (sent.previewUrl && process.env.NODE_ENV !== "production") ? { previewUrl: sent.previewUrl } : {};
    return res.json({ ...generic, ...note });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err);
    return res.status(500).json({ message: "Failed to process request" });
  }
});

/* ------------------------- RESET PASSWORD ----------------------- */
/**
 * POST /api/auth/reset-password
 * Body: { token, email, password }
 * Accepts token + email or only token depending on your frontend
 */
router.post("/reset-password", async (req, res) => {
  try {
    const { token, email, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ message: "Token and new password required" });
    if (typeof password !== "string" || password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    const hashedToken = crypto.createHash("sha256").update(String(token)).digest("hex");

    const query = { resetPasswordToken: hashedToken, resetPasswordExpires: { $gt: new Date() } };
    if (email) query.email = String(email).toLowerCase().trim();

    const user = await User.findOne(query).select("+passwordHash +resetPasswordToken +resetPasswordExpires");
    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    user.passwordHash = String(password); // pre-save hook to hash
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // notify user by email (fire-and-forget)
    mailer.sendEmail({
      to: user.email,
      subject: "Your password has been changed",
      html: `<p>Hello ${user.name || "User"},</p><p>Your password was successfully changed. If you did not do this, contact support immediately.</p>`,
      text: `Your password was successfully changed. If you did not do this, contact support immediately.`,
    }).catch((e) => console.error("password-change-mailer:", e));

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR:", err);
    return res.status(500).json({ message: "Failed to reset password" });
  }
});

export default router;
