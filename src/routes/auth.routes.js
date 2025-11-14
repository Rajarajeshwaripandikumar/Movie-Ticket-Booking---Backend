// backend/src/routes/auth.routes.js
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";

import User from "../models/User.js";
import Theater from "../models/Theater.js";
import mailer from "../models/mailer.js";

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                                   CONSTS                                   */
/* -------------------------------------------------------------------------- */
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const TOKEN_SIZE_BYTES = 32;
const RESET_EXPIRES_MS =
  Number(process.env.RESET_TOKEN_EXPIRES_MINUTES || 60) * 60 * 1000;

const ROLES = {
  USER: "USER",
  ADMIN: "ADMIN",
  THEATRE_ADMIN: "THEATRE_ADMIN",
  SUPER_ADMIN: "SUPER_ADMIN",
};

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */

function normalizeRole(r) {
  if (!r) return null;
  const v = String(r).trim().toUpperCase();
  if (v === "THEATER_ADMIN") return ROLES.THEATRE_ADMIN;
  if (v === "THEATEROWNER") return ROLES.THEATRE_ADMIN;
  if (v === "SUPERADMIN" || v === "SUPER-ADMIN") return ROLES.SUPER_ADMIN;
  if (v === "ADMIN") return ROLES.ADMIN;
  if (v === "USER") return ROLES.USER;
  return v;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      role: normalizeRole(user.role),
      theatreId: user.theatreId ?? user.theaterId ?? null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function safeUserPayload(doc) {
  if (!doc) return null;
  const u = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(u._id),
    email: u.email,
    name: u.name || "",
    phone: u.phone || "",
    role: normalizeRole(u.role),
    theatreId: u.theatreId ?? u.theaterId ?? null,
    preferences:
      u.preferences || {
        language: "en",
        notifications: { email: true, sms: false },
      },
    bookings: Array.isArray(u.bookings) ? u.bookings : [],
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/* -------------------------------------------------------------------------- */
/*                             HEADER AUTH HELPERS                             */
/* -------------------------------------------------------------------------- */
function requireAuthHdr(req, res, next) {
  try {
    const raw = String(req.headers.authorization || "");
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
    if (!token) return res.status(401).json({ message: "Missing token" });
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function requireRoleHdr(...roles) {
  return (req, res, next) => {
    const role = normalizeRole(req.auth?.role);
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (!roles.map(normalizeRole).includes(role))
      return res.status(403).json({ message: "Forbidden" });
    next();
  };
}

/* -------------------------------------------------------------------------- */
/*                             ADMIN LOGIN HANDLER                             */
/* -------------------------------------------------------------------------- */
async function handleAdminLogin(req, res) {
  try {
    const email = String((req.body.email || "").toLowerCase());
    const password = req.body.password;

    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email }).select("+password").lean();
    if (!user) return res.status(401).json({ message: "Email not registered" });

    const norm = normalizeRole(user.role);
    const adminRoles = [ROLES.SUPER_ADMIN, ROLES.THEATRE_ADMIN, ROLES.ADMIN];
    if (!adminRoles.includes(norm))
      return res.status(403).json({ message: "Admins only" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Incorrect password" });

    const token = signToken(user);

    return res.json({
      message: "Admin login successful",
      token,
      adminToken: token,
      role: norm,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("ADMIN_LOGIN_ERROR:", err);
    return res.status(500).json({ message: "Failed to login admin" });
  }
}

/* -------------------------------------------------------------------------- */
/*                             USER REGISTER & LOGIN                           */
/* -------------------------------------------------------------------------- */

router.post("/register", async (req, res) => {
  try {
    const email = String((req.body.email || "").toLowerCase());
    const password = req.body.password;
    const name = req.body.name || "";
    const phone = req.body.phone || "";

    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const exists = await User.findOne({ email }).lean();
    if (exists)
      return res.status(409).json({ message: "Email already registered" });

    const user = new User({ email, name, phone, password, role: ROLES.USER });
    await user.save();

    const token = signToken(user);
    return res.status(201).json({
      message: "Registered successfully",
      token,
      role: ROLES.USER,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("REGISTER_ERROR:", err);
    return res.status(500).json({ message: "Failed to register" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String((req.body.email || "").toLowerCase());
    const password = req.body.password;

    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email }).select("+password").lean();
    if (!user) return res.status(401).json({ message: "Email not registered" });

    const norm = normalizeRole(user.role);
    if ([ROLES.SUPER_ADMIN, ROLES.THEATRE_ADMIN, ROLES.ADMIN].includes(norm)) {
      return res.status(403).json({
        message: "Admins must login via /admin/login",
      });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Incorrect password" });

    const token = signToken(user);
    return res.json({
      message: "Login successful",
      token,
      role: ROLES.USER,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("LOGIN_ERROR:", err);
    return res.status(500).json({ message: "Login failed" });
  }
});

/* -------------------------------------------------------------------------- */
/*                                ADMIN LOGIN                                 */
/* -------------------------------------------------------------------------- */

router.post("/admin-login", handleAdminLogin);
router.post("/admin/login", handleAdminLogin);

/* -------------------------------------------------------------------------- */
/*                       CREATE FIRST SUPER ADMIN                              */
/* -------------------------------------------------------------------------- */

router.post("/create-superadmin", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const email = String((req.body.email || "").toLowerCase());
    const password = req.body.password;
    const name = req.body.name || "";

    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    let created = null;

    await session.withTransaction(async () => {
      const exists = await User.findOne({ role: ROLES.SUPER_ADMIN })
        .session(session)
        .lean();
      if (exists) throw new Error("SUPER_ADMIN_EXISTS");

      const hashed = await bcrypt.hash(password, 10);
      const arr = await User.create(
        [{ email, password: hashed, name, role: ROLES.SUPER_ADMIN }],
        { session }
      );
      created = arr[0];
    });

    return res.json({
      message: "Super Admin created successfully",
      superAdmin: safeUserPayload(created),
    });
  } catch (err) {
    if (String(err.message) === "SUPER_ADMIN_EXISTS") {
      return res.status(409).json({ message: "Super Admin already exists" });
    }
    console.error("CREATE_SUPERADMIN_ERROR:", err);
    return res.status(500).json({ message: "Failed to create super admin" });
  } finally {
    session.endSession();
  }
});

/* -------------------------------------------------------------------------- */
/*                                     ME                                     */
/* -------------------------------------------------------------------------- */

router.get("/me", async (req, res) => {
  try {
    const raw = String(req.headers.authorization || "");
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    return res.json({ user: safeUserPayload(user) });
  } catch (err) {
    console.error("ME_ERROR:", err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               PROFILE UPDATE                                */
/* -------------------------------------------------------------------------- */

router.put("/profile", requireAuthHdr, async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    const update = {};

    if (typeof name === "string") update.name = name.trim();
    if (typeof phone === "string") update.phone = phone.trim();

    if (typeof email === "string") {
      const e = email.trim().toLowerCase();
      const conflict = await User.findOne({
        email: e,
        _id: { $ne: req.auth.sub },
      }).lean();
      if (conflict)
        return res.status(409).json({ message: "Email already in use" });
      update.email = e;
    }

    const user = await User.findByIdAndUpdate(
      req.auth.sub,
      { $set: update },
      { new: true, select: "-password" }
    ).lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    return res.json({ message: "Profile updated", user: safeUserPayload(user) });
  } catch (err) {
    console.error("PROFILE_UPDATE_ERROR:", err);
    return res.status(500).json({ message: "Failed to update profile" });
  }
});

router.put("/profile/password", requireAuthHdr, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res
        .status(400)
        .json({ message: "currentPassword and newPassword required" });

    const user = await User.findById(req.auth.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const ok = await user.compare(currentPassword);
    if (!ok) return res.status(401).json({ message: "Current password incorrect" });

    user.password = newPassword; // pre-save hook will hash
    await user.save();

    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error("PROFILE_PASSWORD_ERROR:", err);
    return res.status(500).json({ message: "Failed to update password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                              TOKEN PASSWORD CHANGE                          */
/* -------------------------------------------------------------------------- */

router.post("/change-password", async (req, res) => {
  try {
    const raw = String(req.headers.authorization || "");
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({
        message: "Both currentPassword and newPassword required",
      });

    const ok = await user.compare(currentPassword);
    if (!ok) return res.status(400).json({ message: "Current password incorrect" });

    user.password = newPassword;
    await user.save();

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err);
    return res.status(500).json({ message: "Failed to change password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                             PASSWORD RESET FLOW                             */
/* -------------------------------------------------------------------------- */

router.post("/forgot-password", async (req, res) => {
  try {
    const email = String((req.body.email || "").toLowerCase());
    if (!email) return res.status(400).json({ message: "Email required." });

    const generic = "If the email exists, you'll receive a reset link.";

    const user = await User.findOne({ email }).select("+resetPasswordToken resetPasswordExpires");
    if (!user) return res.json({ message: generic });

    const token = crypto.randomBytes(TOKEN_SIZE_BYTES).toString("hex");
    const hashed = hashToken(token);
    const expires = new Date(Date.now() + RESET_EXPIRES_MS);

    user.resetPasswordToken = hashed;
    user.resetPasswordExpires = expires;
    await user.save();

    const { resetFrontendUrl } = mailer.createResetUrl({
      token,
      userId: user._id,
      email,
    });

    await mailer.sendEmail({
      to: email,
      subject: "Reset your password",
      html: mailer.resetPasswordTemplate({
        name: user.name || email,
        resetUrl: resetFrontendUrl,
        expiresMinutes: RESET_EXPIRES_MS / 60000,
      }),
      text: `Reset link: ${resetFrontendUrl}`,
    });

    return res.json({ message: generic });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err);
    return res.status(500).json({ message: "Failed to send reset email." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const token = req.body?.token;
    const email = String((req.body.email || "").toLowerCase());
    const newPassword = req.body?.newPassword || req.body?.password;

    if (!token || !newPassword)
      return res.status(400).json({ message: "Token and new password required." });

    const hashed = hashToken(token);
    const user = await User.findOne({
      email,
      resetPasswordToken: hashed,
      resetPasswordExpires: { $gt: Date.now() },
    }).select("+password");

    if (!user)
      return res.status(400).json({ message: "Invalid or expired token." });

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    await mailer.sendEmail({
      to: user.email,
      subject: "Password updated",
      html: `<p>Your password for <b>${user.email}</b> was changed.</p>`,
    });

    return res.json({ message: "Password reset successful." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR:", err);
    return res.status(500).json({ message: "Failed to reset password." });
  }
});

/* -------------------------------------------------------------------------- */
/*                             TOKEN VERIFY & ADMIN CREATION                   */
/* -------------------------------------------------------------------------- */

router.get("/verify", requireAuthHdr, (req, res) => {
  return res.json({ ok: true, token: req.auth });
});

router.post(
  "/admin/create",
  requireAuthHdr,
  requireRoleHdr(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { email, password, name, role, theatreId } = req.body;
      const emailNorm = String((email || "").toLowerCase());

      if (!emailNorm || !password || !role)
        return res.status(400).json({ message: "email, password, role required" });

      const norm = normalizeRole(role);
      if (![ROLES.ADMIN, ROLES.THEATRE_ADMIN].includes(norm))
        return res.status(400).json({ message: "role must be ADMIN or THEATRE_ADMIN" });

      const exists = await User.findOne({ email: emailNorm }).lean();
      if (exists) return res.status(409).json({ message: "Email already registered" });

      let theatreRef = null;
      if (norm === ROLES.THEATRE_ADMIN) {
        if (!mongoose.Types.ObjectId.isValid(theatreId))
          return res.status(400).json({ message: "Invalid theatreId" });
        const th = await Theater.findById(theatreId).lean();
        if (!th) return res.status(400).json({ message: "Invalid theatreId" });
        theatreRef = th._id;
      }

      const hashed = await bcrypt.hash(password, 10);
      const adminUser = await User.create({
        email: emailNorm,
        password: hashed,
        name: name || "",
        role: norm,
        theatreId: theatreRef,
      });

      return res.status(201).json({
        ok: true,
        user: safeUserPayload(adminUser),
      });
    } catch (err) {
      console.error("ADMIN_CREATE_ERROR:", err);
      return res.status(500).json({ message: "Failed to create admin" });
    }
  }
);

/* -------------------------------------------------------------------------- */

router.routesPrefix = "/api/auth";
export default router;
