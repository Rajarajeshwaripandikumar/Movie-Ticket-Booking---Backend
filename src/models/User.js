// backend/src/models/User.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = Number(process.env.PWD_SALT_ROUNDS || 12);
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    phone: { type: String, default: "", index: true },

    // roles: USER, THEATER_ADMIN, SUPER_ADMIN
    role: { type: String, enum: ["USER", "THEATER_ADMIN", "SUPER_ADMIN"], default: "USER", index: true },

    // For clarity: store hashed password in passwordHash, don't return by default
    passwordHash: { type: String, required: true, select: false },

    // If user is a theater admin, link to the Theater
    theater: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", default: null, index: true },

    preferences: {
      language: { type: String, default: "en" },
      notifications: {
        email: { type: Boolean, default: true },
        sms: { type: Boolean, default: false },
      },
    },

    // bookings relation (optional cache)
    bookings: [{ type: mongoose.Schema.Types.ObjectId, ref: "Booking" }],

    // password reset fields
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },

    // any other metadata
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

/* ---------------------- Hooks: hash password ----------------------- */
userSchema.pre("save", async function (next) {
  try {
    if (!this.isModified("passwordHash")) return next();
    const hash = await bcrypt.hash(this.passwordHash, SALT_ROUNDS);
    this.passwordHash = hash;
    next();
  } catch (err) {
    next(err);
  }
});

/* ---------------------- Instance methods -------------------------- */

/**
 * Compare a plain password with stored hash.
 * Note: when loading user from DB, use .select('+passwordHash') if you need to compare.
 */
userSchema.methods.comparePassword = async function (plain) {
  try {
    return await bcrypt.compare(plain, this.passwordHash);
  } catch (err) {
    console.error("comparePassword error", err);
    return false;
  }
};

/**
 * Generate JWT token for this user. Payload includes id and role.
 */
userSchema.methods.generateJWT = function () {
  const payload = { id: this._id.toString(), role: this.role };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

/* ---------------------- Static helpers ---------------------------- */

/**
 * Ensure a super-admin exists (useful for seeding/first-run).
 * Returns { created: boolean, user }
 */
userSchema.statics.ensureSuperAdmin = async function (email = "admin@example.com", password = "Password123!") {
  const User = this;
  let user = await User.findOne({ email }).select("+passwordHash");
  if (user) {
    // ensure role
    if (user.role !== "SUPER_ADMIN") {
      user.role = "SUPER_ADMIN";
      await user.save();
    }
    return { created: false, user };
  }

  user = await User.create({
    name: "Super Admin",
    email,
    passwordHash: password,
    role: "SUPER_ADMIN",
  });

  return { created: true, user };
};

/* ---------------------- toJSON sanitization ----------------------- */
/**
 * Remove sensitive fields when converting to JSON (res.json, console.log)
 */
userSchema.set("toJSON", {
  transform: function (doc, ret) {
    // remove sensitive fields
    delete ret.passwordHash;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

/* ---------------------- Export model ----------------------------- */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
