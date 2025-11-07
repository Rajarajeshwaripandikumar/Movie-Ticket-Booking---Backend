// backend/src/routes/auth.routes.js
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
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
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */
function signToken(user) {
  return jwt.sign(
    {
      sub: user._id,
      email: user.email,
      role: user.role,
      theatreId: user.theatreId || null,
    },
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
    role: u.role || ROLES.USER,
    theatreId: u.theatreId || null,
    preferences:
      u.preferences || { language: "en", notifications: { email: true, sms: false } },
    bookings: u.bookings || [],
    createdAt: u.createdAt,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Lightweight header-based auth for this router
function requireAuthHdr(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ message: "Missing token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.auth?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (!roles.includes(role)) return res.status(403).json({ message: "Forbidden" });
    next();
  };
}

/* --------------------------- Shared Admin Login --------------------------- */
async function handleAdminLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!user) return res.status(401).json({ message: "Email not registered" });

    // Only admins can login here
    const adminRoles = [ROLES.SUPER_ADMIN, ROLES.THEATRE_ADMIN, ROLES.ADMIN];
    if (!adminRoles.includes(user.role)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const match = await user.compare(password); // uses your schema's compare()
    if (!match) return res.status(401).json({ message: "Incorrect password" });

    const token = signToken(user);

    return res.json({
      message: "Admin login successful",
      token,
      adminToken: token, // alias for frontends
      role: user.role,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("ADMIN_LOGIN_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to login admin" });
  }
}

/* -------------------------------------------------------------------------- */
/*                              USER REGISTRATION                             */
/* -------------------------------------------------------------------------- */
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) return res.status(409).json({ message: "Email already registered" });

    const user = new User({
      email: String(email).toLowerCase(),
      name: name || "",
      phone: phone || "",
      role: ROLES.USER,   // self-registers are always USER
      password,           // pre-save hook hashes
    });

    await user.save();
    const token = signToken(user);
    return res.status(201).json({
      message: "Registered successfully",
      token,
      role: user.role,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("REGISTER_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to register" });
  }
});

/* -------------------------------------------------------------------------- */
/*                                   LOGIN (PUBLIC, USER-ONLY)                */
/* -------------------------------------------------------------------------- */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!user) return res.status(401).json({ message: "Email not registered" });

    // ⛔ Admin roles cannot use public login
    if ([ROLES.SUPER_ADMIN, ROLES.THEATRE_ADMIN, ROLES.ADMIN].includes(user.role)) {
      return res.status(403).json({ message: "Admins must login from /admin/login" });
    }

    const match = await user.compare(password);
    if (!match) return res.status(401).json({ message: "Incorrect password" });

    const token = signToken(user);
    return res.json({
      message: "Login successful",
      token,
      role: user.role,
      user: safeUserPayload(user),
    });
  } catch (err) {
    console.error("LOGIN_ERROR:", err.message);
    return res.status(500).json({ message: "Login failed" });
  }
});

/* -------------------------------------------------------------------------- */
/*                           ADMIN LOGIN (ADMIN-ONLY)                         */
/* -------------------------------------------------------------------------- */
router.post("/admin-login", handleAdminLogin);
router.post("/admin/login", handleAdminLogin);

/* -------------------------------------------------------------------------- */
/*                           CREATE FIRST SUPER ADMIN                         */
/* -------------------------------------------------------------------------- */
router.post("/create-superadmin", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const exists = await User.findOne({ role: ROLES.SUPER_ADMIN });
    if (exists) return res.status(409).json({ message: "Super Admin already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const superAdmin = await User.create({
      email: String(email).toLowerCase(),
      password: hashed,
      name,
      role: ROLES.SUPER_ADMIN,
    });

    return res.json({
      message: "Super Admin created successfully",
      superAdmin: safeUserPayload(superAdmin),
    });
  } catch (err) {
    console.error("CREATE_SUPERADMIN_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to create super admin" });
  }
});

/* -------------------------------------------------------------------------- */
/*                                   ME                                       */
/* -------------------------------------------------------------------------- */
router.get("/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub);
    if (!user) return res.status(404).json({ message: "User not found" });

    return res.json({ user: safeUserPayload(user) });
  } catch (err) {
    console.error("ME_ERROR:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               PROFILE (SELF)                               */
/* -------------------------------------------------------------------------- */

// Update my profile (name/email/phone)
router.put("/profile", requireAuthHdr, async (req, res) => {
  try {
    const { name, email, phone } = req.body || {};
    if (!name && !email && !phone)
      return res.status(400).json({ message: "Nothing to update" });

    const update = {};
    if (typeof name === "string") update.name = name.trim();
    if (typeof phone === "string") update.phone = phone.trim();
    if (typeof email === "string") {
      const e = email.trim().toLowerCase();
      const taken = await User.findOne({ email: e, _id: { $ne: req.auth.sub } });
      if (taken) return res.status(409).json({ message: "Email already in use" });
      update.email = e;
    }

    const user = await User.findByIdAndUpdate(
      req.auth.sub,
      { $set: update },
      { new: true, select: "-password" }
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ message: "Profile updated", user: safeUserPayload(user) });
  } catch (err) {
    console.error("PROFILE_UPDATE_ERROR:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// Change my password
router.put("/profile/password", requireAuthHdr, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "Both currentPassword and newPassword required" });

    const user = await User.findById(req.auth.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const ok = await user.compare(currentPassword);
    if (!ok) return res.status(401).json({ message: "Current password incorrect" });

    user.password = newPassword; // pre-save hook hashes
    await user.save();
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error("PROFILE_PASSWORD_ERROR:", err);
    res.status(500).json({ message: "Failed to update password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               CHANGE PASSWORD                              */
/* -------------------------------------------------------------------------- */
router.post("/change-password", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.sub).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "Both current and new passwords required" });

    const match = await user.compare(currentPassword);
    if (!match) return res.status(400).json({ message: "Current password incorrect" });

    user.password = newPassword;
    await user.save();

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE_PASSWORD_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to change password" });
  }
});

/* -------------------------------------------------------------------------- */
/*                        PASSWORD RESET (Email Flow)                         */
/* -------------------------------------------------------------------------- */
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required." });

    const genericMsg = "If that email exists, you'll receive reset instructions.";
    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
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
      email: normalizedEmail,
    });

    const html = mailer.resetPasswordTemplate({
      name: user.name || user.email,
      resetUrl: resetFrontendUrl,
      expiresMinutes: Math.round(RESET_EXPIRES_MS / 60000),
    });

    await mailer.sendEmail({
      to: normalizedEmail,
      subject: "Reset your password",
      html,
      text: `Reset your password: ${resetFrontendUrl}`,
    });

    return res.json({ message: genericMsg });
  } catch (err) {
    console.error("FORGOT_PASSWORD_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to send reset email." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, email } = req.body;
    const newPassword = req.body.newPassword || req.body.password;
    if (!token || !newPassword)
      return res.status(400).json({ message: "Token and new password required." });

    const hashedToken = hashToken(String(token));
    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
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
    console.error("RESET_PASSWORD_ERROR:", err.message);
    return res.status(500).json({ message: "Failed to reset password." });
  }
});

/* -------------------------------------------------------------------------- */
/*                             TOKEN VERIFY                                   */
/* -------------------------------------------------------------------------- */
router.get("/verify", requireAuthHdr, (req, res) => {
  return res.json({ ok: true, token: req.auth });
});

/* -------------------------------------------------------------------------- */
/*                     ADMIN MANAGEMENT (SUPER ADMIN)                         */
/* -------------------------------------------------------------------------- */
router.post(
  "/admin/create",
  requireAuthHdr,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { email, password, name, role, theatreId } = req.body;

      if (!email || !password || !role) {
        return res
          .status(400)
          .json({ message: "email, password and role are required" });
      }
      if (![ROLES.ADMIN, ROLES.THEATRE_ADMIN].includes(role)) {
        return res
          .status(400)
          .json({ message: "role must be ADMIN or THEATRE_ADMIN" });
      }

      const exists = await User.findOne({ email: String(email).toLowerCase() });
      if (exists) return res.status(409).json({ message: "Email already registered" });

      let theatreRef = undefined;
      if (role === ROLES.THEATRE_ADMIN && theatreId) {
        const t = await Theater.findById(theatreId).select("_id");
        if (!t) return res.status(400).json({ message: "Invalid theatreId" });
        theatreRef = t._id;
      }

      const hashed = await bcrypt.hash(password, 10);
      const admin = await User.create({
        email: String(email).toLowerCase(),
        password: hashed,
        name: name || "",
        role,
        theatreId: theatreRef || null,
      });

      return res.status(201).json({ ok: true, user: safeUserPayload(admin) });
    } catch (err) {
      console.error("ADMIN_CREATE_ERROR:", err);
      return res.status(500).json({ message: "Failed to create admin" });
    }
  }
);

/* -------------------------------------------------------------------------- */
router.routesPrefix = "/api/auth";
export default router;
