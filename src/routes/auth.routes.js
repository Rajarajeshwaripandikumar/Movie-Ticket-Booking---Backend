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

/* canonical roles */
const ROLES = {
  USER: "USER",
  ADMIN: "ADMIN",
  THEATRE_ADMIN: "THEATRE_ADMIN",
  SUPER_ADMIN: "SUPER_ADMIN",
};

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */

function normalizeRole(r) {
  if (!r) return null;
  const v = String(r).trim().toUpperCase().replace(/\s+/g, "_");
  if (v === "THEATER_ADMIN" || v === "THEATER_OWNER") return ROLES.THEATRE_ADMIN;
  if (v === "SUPERADMIN" || v === "SUPER-ADMIN") return ROLES.SUPER_ADMIN;
  if (v === "ADMIN") return ROLES.ADMIN;
  if (v === "USER") return ROLES.USER;
  return v;
}

function signToken(user) {
  // ensure sub is string for reliable decoding
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      role: user.role,
      theatreId: user.theatreId ?? null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function safeUserPayload(userDoc) {
  if (!userDoc) return null;
  // if it's a mongoose doc, convert to POJO; if already POJO, copy fields
  const u = userDoc.toObject ? userDoc.toObject() : userDoc;
  return {
    id: String(u._id),
    email: u.email,
    name: u.name || "",
    phone: u.phone || "",
    role: normalizeRole(u.role) || ROLES.USER,
    theatreId: u.theatreId ?? u.theaterId ?? null,
    preferences:
      u.preferences ?? { language: "en", notifications: { email: true, sms: false } },
    bookings: Array.isArray(u.bookings) ? u.bookings : [],
    createdAt: u.createdAt,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/* Lightweight header-based auth for WRITE endpoints in this router */
function requireAuthHdr(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header;
    if (!token) return res.status(401).json({ message: "Missing token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function requireRoleHdr(...roles) {
  return (req, res, next) => {
    const role = normalizeRole(req.auth?.role);
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    const ok = roles.map(normalizeRole).includes(role);
    if (!ok) return res.status(403).json({ message: "Forbidden" });
    next();
  };
}

/* -------------------------------------------------------------------------- */
/*                              ADMIN LOGIN HELPERS                            */
/* -------------------------------------------------------------------------- */
async function handleAdminLogin(req, res) {
  try {
    const email = String((req.body?.email || "").toLowerCase()).trim();
    const password = req.body?.password;

    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    // fetch plain object with password hash to avoid running virtual getters
    const user = await User.findOne({ email }).select("+password").lean();
    if (!user) return res.status(401).json({ message: "Email not registered" });

    const userRole = normalizeRole(user.role);

    // debug log in non-prod to aid troubleshooting
    if (process.env.NODE_ENV !== "production") {
      console.debug("[ADMIN_LOGIN] attempt:", { email, role: userRole });
    }

    // Only admins allowed here
    const adminRoles = [ROLES.SUPER_ADMIN, ROLES.THEATRE_ADMIN, ROLES.ADMIN];
    if (!adminRoles.includes(userRole)) {
      return res.status(403).json({ message: "Admins only" });
    }

    // Compare using bcrypt directly against the stored hash (user is a POJO)
    const match = await bcrypt.compare(password, user.password || "");
    if (!match) return res.status(401).json({ message: "Incorrect password" });

    // sign token using canonical role (keep original stored role but normalized in token)
    const token = signToken({ _id: user._id, email: user.email, role: userRole, theatreId: user.theatreId });

    return res.json({
      message: "Admin login successful",
      token,
      adminToken: token,
      role: userRole,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("ADMIN_LOGIN_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to login admin" });
  }
}

/* -------------------------------------------------------------------------- */
/*                              REGISTER / LOGIN                               */
/* -------------------------------------------------------------------------- */
router.post("/register", async (req, res) => {
  try {
    const email = String((req.body?.email || "").toLowerCase()).trim();
    const password = req.body?.password;
    const name = req.body?.name || "";
    const phone = req.body?.phone || "";

    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const existing = await User.findOne({ email }).lean();
    if (existing) return res.status(409).json({ message: "Email already registered" });

    const user = new User({
      email,
      name,
      phone,
      role: ROLES.USER,
      password, // pre-save hook will hash
    });

    await user.save();

    const token = signToken(user);
    return res.status(201).json({
      message: "Registered successfully",
      token,
      role: normalizeRole(user.role),
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("REGISTER_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to register" });
  }
});

/* Public login for normal users (explicitly rejects admin roles) */
router.post("/login", async (req, res) => {
  try {
    const email = String((req.body?.email || "").toLowerCase()).trim();
    const password = req.body?.password;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    // use lean to avoid virtuals being evaluated during auth; compare with bcrypt
    const user = await User.findOne({ email }).select("+password").lean();
    if (!user) return res.status(401).json({ message: "Email not registered" });

    const userRole = normalizeRole(user.role);
    if ([ROLES.SUPER_ADMIN, ROLES.THEATRE_ADMIN, ROLES.ADMIN].includes(userRole)) {
      return res.status(403).json({ message: "Admins must login from /admin/login" });
    }

    const match = await bcrypt.compare(password, user.password || "");
    if (!match) return res.status(401).json({ message: "Incorrect password" });

    const token = signToken(user);
    return res.json({
      message: "Login successful",
      token,
      role: normalizeRole(user.role),
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("LOGIN_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Login failed" });
  }
});

/* Admin login endpoints */
router.post("/admin-login", handleAdminLogin);
router.post("/admin/login", handleAdminLogin);

/* -------------------------------------------------------------------------- */
/*                   CREATE FIRST SUPER ADMIN (transactional)                 */
/* -------------------------------------------------------------------------- */
router.post("/create-superadmin", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const email = String((req.body?.email || "").toLowerCase()).trim();
    const password = req.body?.password;
    const name = req.body?.name || "";

    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    let created = null;
    await session.withTransaction(async () => {
      const exists = await User.findOne({ role: ROLES.SUPER_ADMIN }).session(session).lean();
      if (exists) {
        // abort transaction by throwing a special error we catch below
        throw new Error("SUPER_ADMIN_EXISTS");
      }

      const hashed = await bcrypt.hash(password, 10);
      created = await User.create(
        [
          {
            email,
            password: hashed,
            name,
            role: ROLES.SUPER_ADMIN,
          },
        ],
        { session }
      );
      // created is an array returned by create when array provided
      created = Array.isArray(created) ? created[0] : created;
    });

    if (!created) {
      return res.status(500).json({ message: "Failed to create super admin" });
    }

    return res.json({ message: "Super Admin created successfully", superAdmin: safeUserPayload(created) });
  } catch (err) {
    if (String(err.message) === "SUPER_ADMIN_EXISTS") {
      return res.status(409).json({ message: "Super Admin already exists" });
    }
    console.error("CREATE_SUPERADMIN_ERROR:", err && err.stack ? err.stack : err);
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
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header;
    if (!token) return res.status(401).json({ message: "Missing token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ user: safeUserPayload(user) });
  } catch (err) {
    console.error("ME_ERROR:", err && err.stack ? err.stack : err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               PROFILE (SELF)                                */
/* -------------------------------------------------------------------------- */
router.put("/profile", requireAuthHdr, async (req, res) => {
  try {
    const { name, email, phone } = req.body || {};
    if (!name && !email && !phone) return res.status(400).json({ message: "Nothing to update" });

    const update = {};
    if (typeof name === "string") update.name = name.trim();
    if (typeof phone === "string") update.phone = phone.trim();
    if (typeof email === "string") {
      const e = email.trim().toLowerCase();
      const taken = await User.findOne({ email: e, _id: { $ne: req.auth.sub } }).lean();
      if (taken) return res.status(409).json({ message: "Email already in use" });
      update.email = e;
    }

    const user = await User.findByIdAndUpdate(req.auth.sub, { $set: update }, { new: true, select: "-password" }).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ message: "Profile updated", user: safeUserPayload(user) });
  } catch (err) {
    console.error("PROFILE_UPDATE_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to update profile" });
  }
});

router.put("/profile/password", requireAuthHdr, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both currentPassword and newPassword required" });

    const user = await User.findById(req.auth.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const ok = await user.compare(currentPassword);
    if (!ok) return res.status(401).json({ message: "Current password incorrect" });

    user.password = newPassword;
    await user.save();
    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error("PROFILE_PASSWORD_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to update password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                        CHANGE PASSWORD (token auth)                         */
/* -------------------------------------------------------------------------- */
router.post("/change-password", async (req, res) => {
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header;
    if (!token) return res.status(401).json({ message: "Missing token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: "Both current and new passwords required" });

    const match = await user.compare(currentPassword);
    if (!match) return res.status(400).json({ message: "Current password incorrect" });

    user.password = newPassword;
    await user.save();
    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to change password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                        PASSWORD RESET (Email Flow)                         */
/* -------------------------------------------------------------------------- */
router.post("/forgot-password", async (req, res) => {
  try {
    const email = String((req.body?.email || "").toLowerCase()).trim();
    if (!email) return res.status(400).json({ message: "Email required." });

    const genericMsg = "If that email exists, you'll receive reset instructions.";
    const user = await User.findOne({ email }).select("+resetPasswordToken resetPasswordExpires");
    if (!user) return res.json({ message: genericMsg });

    const token = crypto.randomBytes(TOKEN_SIZE_BYTES).toString("hex");
    const hashedToken = hashToken(token);
    const expires = Date.now() + RESET_EXPIRES_MS;

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(expires);
    await user.save();

    const { resetFrontendUrl } = mailer.createResetUrl({
      token,
      userId: user._id,
      email,
    });

    const html = mailer.resetPasswordTemplate({
      name: user.name || user.email,
      resetUrl: resetFrontendUrl,
      expiresMinutes: Math.round(RESET_EXPIRES_MS / 60000),
    });

    await mailer.sendEmail({
      to: email,
      subject: "Reset your password",
      html,
      text: `Reset your password: ${resetFrontendUrl}`,
    });

    return res.json({ message: genericMsg });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to send reset email." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const token = req.body?.token;
    const email = String((req.body?.email || "").toLowerCase()).trim();
    const newPassword = req.body?.newPassword || req.body?.password;
    if (!token || !newPassword) return res.status(400).json({ message: "Token and new password required." });

    const hashedToken = hashToken(String(token));
    const user = await User.findOne({
      email,
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).select("+password");

    if (!user) return res.status(400).json({ message: "Invalid or expired token." });

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    await mailer.sendEmail({
      to: user.email,
      subject: "Your password has been changed",
      html: `<p>Your password for <b>${user.email}</b> was updated.</p>`,
      text: `Your password for ${user.email} was updated.`,
    });

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR:", err && err.stack ? err.stack : err);
    return res.status(500).json({ message: "Failed to reset password." });
  }
});

/* -------------------------------------------------------------------------- */
/*                        TOKEN VERIFY & ADMIN MANAGEMENT                      */
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
      const email = String((req.body?.email || "").toLowerCase()).trim();
      const password = req.body?.password;
      const name = req.body?.name || "";
      const role = normalizeRole(req.body?.role);
      const theatreId = req.body?.theatreId;

      if (!email || !password || !role) {
        return res.status(400).json({ message: "email, password and role are required" });
      }
      if (![ROLES.ADMIN, ROLES.THEATRE_ADMIN].includes(role)) {
        return res.status(400).json({ message: "role must be ADMIN or THEATRE_ADMIN" });
      }

      const exists = await User.findOne({ email }).lean();
      if (exists) return res.status(409).json({ message: "Email already registered" });

      let theatreRef = null;
      if (role === ROLES.THEATRE_ADMIN && theatreId) {
        if (!mongoose.Types.ObjectId.isValid(theatreId)) {
          return res.status(400).json({ message: "Invalid theatreId" });
        }
        const t = await Theater.findById(theatreId).select("_id").lean();
        if (!t) return res.status(400).json({ message: "Invalid theatreId" });
        theatreRef = t._id;
      }

      const hashed = await bcrypt.hash(password, 10);
      const admin = await User.create({
        email,
        password: hashed,
        name: name || "",
        role,
        theatreId: theatreRef || null,
      });

      return res.status(201).json({ ok: true, user: safeUserPayload(admin) });
    } catch (err) {
      console.error("ADMIN_CREATE_ERROR:", err && err.stack ? err.stack : err);
      return res.status(500).json({ message: "Failed to create admin" });
    }
  }
);

router.routesPrefix = "/api/auth";
export default router;
