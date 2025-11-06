// backend/src/routes/auth.passwords.js
import { Router } from "express";
import crypto from "crypto";
import User from "../models/User.js";
import mailer from "../models/mailer.js"; // must export sendEmail (and optionally templates)

const router = Router();

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */

const RESET_EXPIRES_MINUTES = Number(process.env.RESET_TOKEN_EXPIRES_MINUTES || process.env.RESET_TOKEN_EXPIRY_MIN || 60);
const APP_PUBLIC_BASE =
  process.env.APP_PUBLIC_BASE ||
  process.env.CLIENT_BASE_URL ||
  process.env.FRONTEND_URL ||
  "http://localhost:5173";

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                   */
/* -------------------------------------------------------------------------- */

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function buildResetUrl(token, email) {
  const base = APP_PUBLIC_BASE.replace(/\/$/, "");
  const params = new URLSearchParams({ token, email });
  // Frontend page expected at /reset-password
  return `${base}/reset-password?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/*                             FORGOT PASSWORD                                 */
/* POST /api/auth/forgot-password  { email }                                   */
/* -------------------------------------------------------------------------- */

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required" });

    const normalized = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalized });

    // Always respond generically to prevent email enumeration
    const generic = { message: "If that email exists, a reset link has been sent." };

    if (!user) return res.json(generic);

    // Create token + hash; store only the hash
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashed = hashToken(rawToken);
    const expires = new Date(Date.now() + RESET_EXPIRES_MINUTES * 60 * 1000);

    user.resetPasswordToken = hashed;
    user.resetPasswordExpires = expires;
    await user.save();

    // Compose email
    const resetUrl = buildResetUrl(rawToken, normalized);
    const name = user.name || normalized;

    // Prefer template if your mailer provides one
    const html =
      mailer.resetPasswordTemplate?.({
        name,
        resetUrl,
        expiresMinutes: RESET_EXPIRES_MINUTES,
      }) ||
      `
        <p>Hello ${name},</p>
        <p>You (or someone else) requested a password reset. Click the link below to reset your password.</p>
        <p><a href="${resetUrl}">Reset your password</a></p>
        <p>This link expires in ${RESET_EXPIRES_MINUTES} minutes. If you did not request this, you can ignore this email.</p>
      `;

    const ok = await mailer.sendEmail({
      to: normalized,
      subject: "Reset your password",
      html,
      text: `Reset your password: ${resetUrl}\nThis link expires in ${RESET_EXPIRES_MINUTES} minutes.`,
    });

    if (!ok?.ok) {
      // Don’t leak mail errors to client, but log for ops
      console.error("[Auth] forgot-password mail failed:", ok?.error || ok);
    }

    return res.json(generic);
  } catch (err) {
    console.error("[Auth] forgot-password error:", err);
    return res.status(500).json({ message: "Failed to process request." });
  }
});

/* -------------------------------------------------------------------------- */
/*                              RESET PASSWORD                                 */
/* POST /api/auth/reset-password  { email, token, newPassword }                */
/* -------------------------------------------------------------------------- */

router.post("/reset-password", async (req, res) => {
  try {
    const { email, token } = req.body || {};
    const newPassword = req.body.newPassword || req.body.password;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ message: "email, token, and newPassword are required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const normalized = String(email).toLowerCase().trim();
    const hashed = hashToken(token);

    const user = await User.findOne({
      email: normalized,
      resetPasswordToken: hashed,
      resetPasswordExpires: { $gt: new Date() },
    }).select("+password"); // allow setting new password

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    // IMPORTANT: rely on your User pre-save hook to hash the password
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Optional confirmation email
    try {
      await mailer.sendEmail({
        to: normalized,
        subject: "Your password has been changed",
        html: `<p>Hello ${user.name || normalized},</p><p>Your password was successfully changed. If you did not do this, please contact support immediately.</p>`,
        text: `Your password was successfully changed. If you did not do this, please contact support immediately.`,
      });
    } catch (e) {
      console.warn("[Auth] reset-password confirmation mail failed:", e?.message || e);
    }

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    console.error("[Auth] reset-password error:", err);
    return res.status(500).json({ message: "Failed to reset password." });
  }
});

/* -------------------------------------------------------------------------- */
/*                           ROUTER PREFIX (FYI)                               */
/* -------------------------------------------------------------------------- */
// Mount at /api/auth in your server bootstrap (same as other auth routes)
// e.g. app.use("/api/auth", authPasswordsRouter);

export default router;
