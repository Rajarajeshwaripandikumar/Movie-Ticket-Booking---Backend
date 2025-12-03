// backend/src/models/User.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

const preferencesSchema = new mongoose.Schema(
  {
    language: { type: String, default: "en" },
    notifications: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    phone: { type: String, default: "" },

    // roles used across app
    role: {
      type: String,
      enum: ["USER", "ADMIN", "THEATER_ADMIN", "THEATRE_ADMIN", "SUPER_ADMIN"],
      default: "USER",
      index: true,
    },

    // canonical theater ref
    theater: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      default: null,
    },

    // legacy alias for older code
    theatreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      default: null,
    },

    // 🔐 what auth.routes.js expects
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    preferences: {
      type: preferencesSchema,
      default: () => ({
        language: "en",
        notifications: { email: true, sms: false, push: false },
      }),
    },

    bookings: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Booking",
      },
    ],

    resetPasswordToken: { type: String, default: undefined },
    resetPasswordExpires: { type: Date, default: undefined },

    avatarUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* 🔐 Pre-save hook — hash passwordHash before saving                         */
/* -------------------------------------------------------------------------- */
userSchema.pre("save", async function (next) {
  if (!this.isModified("passwordHash")) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(String(this.passwordHash), salt);
    this.passwordHash = hashed;
    next();
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* 🔑 Compare passwords                                                       */
/* -------------------------------------------------------------------------- */
userSchema.methods.comparePassword = async function (enteredPassword) {
  if (!this.passwordHash) return false;
  try {
    return await bcrypt.compare(String(enteredPassword), this.passwordHash);
  } catch (err) {
    console.error("Password comparison error:", err);
    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* 🎫 JWT helper                                                              */
/* -------------------------------------------------------------------------- */
userSchema.methods.generateJWT = function () {
  const payload = {
    id: this._id.toString(),
    role: this.role,
    theatreId: this.theater || this.theatreId || null,
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
};

/* -------------------------------------------------------------------------- */
/* ✅ Export model                                                            */
/* -------------------------------------------------------------------------- */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
