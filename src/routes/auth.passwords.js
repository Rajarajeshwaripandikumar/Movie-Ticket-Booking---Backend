// backend/src/routes/auth.passwords.js
import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import User from "../models/User.js";
import { sendMail } from "../utils/email.js";

const router = Router();
const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const RESET_EXP_MIN = Number(process.env.RESET_TOKEN_EXPIRY_MIN || 60);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Generates a token, stores it on user with expiry, and emails reset link.
 */
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      // respond 200 anyway to avoid email enumeration
      return res.json({ message: "If that email exists, a reset link has been sent" });
    }

    // generate token
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + RESET_EXP_MIN * 60 * 1000);

    user.resetPasswordToken = token;
    user.resetPasswordExpires = expires;
    await user.save();

    // send email with reset link
    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;

    const html = `
      <p>Hello ${user.name},</p>
      <p>You (or someone else) requested a password reset. Click the link below to reset your password. This link expires in ${RESET_EXP_MIN} minutes.</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>If you did not request this, ignore this email.</p>
    `;

    await sendMail({
      to: user.email,
      subject: "Password reset request",
      html,
      text: `Reset your password: ${resetUrl}`
    });

    return res.json({ message: "If that email exists, a reset link has been sent" });
  } catch (e) {
    console.error("[Auth] forgot password error", e);
    res.status(500).json({ message: "Failed to process request" });
  }
});

/**
 * POST /api/auth/reset-password
 * Body: { email, token, newPassword }
 * Validates token and expiry, sets new password.
 */
router.post("/reset-password", async (req, res) => {
  try {
    const { email, token, newPassword } = req.body || {};
    if (!email || !token || !newPassword) return res.status(400).json({ message: "email, token and newPassword required" });
    if (newPassword.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    const user = await User.findOne({ email: String(email).toLowerCase().trim(), resetPasswordToken: token });
    if (!user) return res.status(400).json({ message: "Invalid token or email" });
    if (!user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      return res.status(400).json({ message: "Token expired" });
    }

    // update password
    const hash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
    user.password = hash;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    // Optionally: send confirmation email
    await sendMail({
      to: user.email,
      subject: "Your password has been changed",
      html: `<p>Hello ${user.name},</p><p>Your password was successfully changed. If you did not do this, contact support.</p>`,
      text: `Your password was successfully changed. If you did not do this, contact support.`
    });

    res.json({ message: "Password reset successful" });
  } catch (e) {
    console.error("[Auth] reset password error", e);
    res.status(500).json({ message: "Failed to reset password" });
  }
});

export default router;
