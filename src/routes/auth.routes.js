import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs"; // keep for compatibility if used elsewhere
import crypto from "crypto";
import nodemailer from "nodemailer";
import User from "../models/User.js";

const router = express.Router();

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign(
    { sub: user._id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
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
    preferences:
      u.preferences || { language: "en", notifications: { email: true, sms: false } },
    bookings: u.bookings || [],
    createdAt: u.createdAt,
  };
}

// -----------------------------------------------------------------------------
// TEMPORARY ADMIN SEEDING ROUTE (DELETE IMMEDIATELY AFTER USE)
// -----------------------------------------------------------------------------
// USE THIS ONCE with any password to ensure the admin user exists in the database.
router.post("/seed-admin", async (req, res) => {
  const { password } = req.body;
  const email = "admin@cinema.com";
  
  if (!password) {
    return res.status(400).json({ message: "Password required in request body" });
  }

  try {
    let user = await User.findOne({ email });

    if (user && user.role === "ADMIN") {
      return res.status(200).json({ message: `Admin account already exists: ${email}. Please DELETE this route now.` });
    }
    
    // Create new admin user if not found, or update existing user to ADMIN role
    user = user || new User({
      email: email,
      name: "Admin User",
      role: "ADMIN",
    });
    
    user.role = "ADMIN";
    user.password = password; // Trigger pre-save hash hook
    await user.save();
    
    return res.status(201).json({ 
      message: `Admin account created/updated: ${email}. Use this password to log in. Please DELETE this route immediately.`,
      user: safeUserPayload(user)
    });
  } catch (err) {
    console.error("ADMIN_SEED_ERROR:", err.message);
    res.status(500).json({ message: "Failed to seed admin user" });
  }
});


// -----------------------------------------------------------------------------
// REGISTER (User or Admin)
// -----------------------------------------------------------------------------
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone, roleParam } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ message: "Email already registered" });

    const user = new User({
      email: email.toLowerCase(),
      name: name || "",
      phone: phone || "",
      role: roleParam === "ADMIN" ? "ADMIN" : "USER",
      password, // pre-save hook hashes
    });

    await user.save();

    const token = signToken(user);
    res.status(201).json({
      message: "Registered successfully",
      token,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("REGISTER_ERROR:", err.message);
    res.status(500).json({ message: "Failed to register" });
  }
});

// -----------------------------------------------------------------------------
// LOGIN (User)
// -----------------------------------------------------------------------------
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!user)
      return res.status(401).json({ message: "Email not registered" });

    const match = await user.compare(password);
    if (!match)
      return res.status(401).json({ message: "Incorrect password" });

    if (user.role === "ADMIN")
      return res.status(403).json({ message: "Please login via /admin/login" });

    const token = signToken(user);
    res.json({
      message: "Login successful",
      token,
      user: safeUserPayload(user),
    });
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
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const admin = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!admin || admin.role !== "ADMIN")
      return res.status(401).json({ message: "Unauthorized — not an admin" });

    const ok = await admin.compare(password);
    if (!ok)
      return res.status(401).json({ message: "Invalid password" });

    const token = signToken(admin);
    res.json({
      message: "Admin login successful",
      token,
      user: safeUserPayload(admin),
    });
  } catch (err) {
    console.error("ADMIN_LOGIN_ERROR:", err.message);
    res.status(500).json({ message: "Admin login failed" });
  }
});

// -----------------------------------------------------------------------------
// GET /auth/me — verify JWT and return user info
// -----------------------------------------------------------------------------
router.get("/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token)
      return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub);
    if (!user)
      return res.status(404).json({ message: "User not found" });

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
    if (!token)
      return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).select("+password");
    if (!user)
      return res.status(404).json({ message: "User not found" });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "Both current and new passwords required" });

    const match = await user.compare(currentPassword);
    if (!match)
      return res.status(400).json({ message: "Current password is incorrect" });

    user.password = newPassword; // triggers pre-save hash
    await user.save();

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err.message);
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError")
      return res.status(401).json({ message: "Invalid or expired token" });

    res.status(500).json({ message: "Failed to change password" });
  }
});

// -----------------------------------------------------------------------------
// FORGOT PASSWORD — send reset email (no previewUrl returned)
// -----------------------------------------------------------------------------
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email)
    return res.status(400).json({ message: "Email required." });

  try {
    const genericMsg = "If that email exists, you'll receive reset instructions.";
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // don't reveal whether account exists
      return res.json({ message: genericMsg });
    }

    // create token (store hash)
    const token = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const expires = Date.now() + 1000 * 60 * 60; // 1 hour

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(expires);
    await user.save();

    // transport: real SMTP if provided, Ethereal fallback in dev
    let transporter;
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    } else {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass },
      });
      if (process.env.NODE_ENV === "production") {
        console.warn("⚠️ Missing SMTP env; using Ethereal fallback in production.");
      }
    }

    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    const resetUrl = `${clientUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || "no-reply@example.com",
      to: email,
      subject: "Password Reset Instructions",
      html: `<p>You requested a password reset. Click the link below:</p>
             <p><a href="${resetUrl}">${resetUrl}</a></p>
             <p>If you didn’t request this, ignore this email.</p>`,
    });

    // ✅ Do NOT return or log preview URL
    return res.json({ message: genericMsg });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to send reset email." });
  }
});

// -----------------------------------------------------------------------------
// RESET PASSWORD — token + new password (email not required)
// -----------------------------------------------------------------------------
router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body; // matches your frontend
  if (!token || !password)
    return res.status(400).json({ message: "Token and new password required." });

  try {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).select("+password");

    if (!user)
      return res.status(400).json({ message: "Invalid or expired token." });

    user.password = password; // pre-save hook hashes
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to reset password." });
  }
});

export default router;
