// backend/src/models/user.model.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

/* ------------------------------- Role constants ------------------------------ */
export const ROLE = {
  USER: "USER",
  THEATRE_ADMIN: "THEATRE_ADMIN", // canonical
  SUPER_ADMIN: "SUPER_ADMIN",
};

// Accept both spellings, but we'll normalize to THEATRE_ADMIN via `set`
const ROLE_ENUM_ACCEPTED = [ROLE.USER, ROLE.THEATRE_ADMIN, ROLE.SUPER_ADMIN, "THEATER_ADMIN"];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, default: "", trim: true },

    role: {
      type: String,
      enum: ROLE_ENUM_ACCEPTED,
      default: ROLE.USER,
      set: (v) => {
        if (!v) return ROLE.USER;
        const val = String(v).toUpperCase().trim();
        if (val === "THEATER_ADMIN") return ROLE.THEATRE_ADMIN; // normalize US -> UK
        return val;
      },
      get: (v) => v, // ensure we return the normalized value
    },

    theatreId: { type: mongoose.Schema.Types.ObjectId, ref: "Theatre", default: null },

    // Keep select:false; remember to .select('+password') when fetching for login
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
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/* 🔐 Hash password before saving */
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

/* (Optional) Hash on findOneAndUpdate if password is being updated */
userSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate?.() || {};
  if (update.password) {
    const salt = await bcrypt.genSalt(10);
    update.password = await bcrypt.hash(update.password, salt);
    this.setUpdate(update);
  }
  next();
});

/* 🔑 Compare passwords */
userSchema.methods.compare = async function (enteredPassword) {
  try {
    return await bcrypt.compare(enteredPassword, this.password);
  } catch (err) {
    console.error("Password comparison error:", err);
    return false;
  }
};

/* ✅ Export model */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
