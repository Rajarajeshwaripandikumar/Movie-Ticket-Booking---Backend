// backend/src/models/User.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, default: "" },

    // expanded roles: USER, ADMIN (generic), THEATRE_ADMIN (scoped), SUPER_ADMIN (full access)
    role: {
      type: String,
      enum: ["USER", "ADMIN", "THEATRE_ADMIN", "SUPER_ADMIN"],
      default: "USER",
      index: true,
    },

    // for theatre-scoped admins: store which theatre they manage
    theatreId: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", default: null },

    password: { type: String, required: true, select: false },

    preferences: {
      language: { type: String, default: "en" },
      notifications: {
        email: { type: Boolean, default: true },
        sms: { type: Boolean, default: false },
      },
    },

    bookings: [{ type: mongoose.Schema.Types.ObjectId, ref: "Booking" }],

    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    avatarUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* 🔐 Pre-save hook — hash password before saving                             */
/* -------------------------------------------------------------------------- */
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* 🔑 Compare passwords                                                       */
/* -------------------------------------------------------------------------- */
userSchema.methods.compare = async function (enteredPassword) {
  try {
    return await bcrypt.compare(enteredPassword, this.password);
  } catch (err) {
    console.error("Password comparison error:", err);
    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* ✅ Export model                                                            */
/* -------------------------------------------------------------------------- */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
