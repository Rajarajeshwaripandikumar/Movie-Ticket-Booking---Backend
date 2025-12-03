// backend/src/routes/auth.passwords.js
import { Router } from "express";
import crypto from "crypto";
import User from "../models/User.js";
import mailer from "../models/mailer.js";

const router = Router();

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

    const normalized = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalized });
    if (!user) {
      // Do not reveal whether email exists
      return res.json({ message: "If that email exists, a reset link has been sent" });
    }

    // generate token and expiry
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + RESET_EXP_MIN * 60 * 1000);

    // set token fields (these fields are stored with select:false in the model)
    user.resetPasswordToken = token;
    user.resetPasswordExpires = expires;
    await user.save();

    // build reset URL for frontend
    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;

    // use mailer (your backend/src/models/mailer.js)
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
      subject: "MovieBook — Password reset request",
      html,
      text: `Reset your password: ${resetUrl}`,
    });

    // in dev Ethereal previewUrl will be present; we log/return preview for convenience only in dev
    const note = sent.previewUrl ? { previewUrl: sent.previewUrl } : {};
    return res.json({ message: "If that email exists, a reset link has been sent", ...note });
  } catch (e) {
    console.error("[Auth] forgot password error", e);
    return res.status(500).json({ message: "Failed to process request" });
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
    if (typeof newPassword !== "string" || newPassword.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    const normalized = String(email).toLowerCase().trim();

    // find user by email + token
    const user = await User.findOne({ email: normalized, resetPasswordToken: token }).select("+passwordHash +resetPasswordToken +resetPasswordExpires");
    if (!user) return res.status(400).json({ message: "Invalid token or email" });

    if (!user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      return res.status(400).json({ message: "Token expired" });
    }

    // Set new password in the model field `passwordHash` **as plain text**.
    // The User model's pre-save hook will hash `passwordHash` before saving.
    user.passwordHash = String(newPassword);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save(); // triggers pre-save hashing

    // Send confirmation email (fire-and-forget)
    mailer.sendEmail({
      to: user.email,
      subject: "Your password has been changed",
      html: `<p>Hello ${user.name || "User"},</p><p>Your password was successfully changed. If you did not do this, contact support immediately.</p>`,
      text: `Your password was successfully changed. If you did not do this, contact support immediately.`,
    }).then(r => {
      if (r.previewUrl) console.log("Password change email preview:", r.previewUrl);
    }).catch(err => console.error("Password change mail error:", err));

    return res.json({ message: "Password reset successful" });
  } catch (e) {
    console.error("[Auth] reset password error", e);
    return res.status(500).json({ message: "Failed to reset password" });
  }
});

export default router;
