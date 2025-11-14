// backend/src/models/User.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

/* ------------------------------- Role constants ------------------------------ */
export const ROLE = {
  USER: "USER",
  THEATRE_ADMIN: "THEATRE_ADMIN",
  SUPER_ADMIN: "SUPER_ADMIN",
};

// accepted enum values (we accept the American spelling, but normalize it)
const ROLE_ENUM_ACCEPTED = [
  ROLE.USER,
  ROLE.THEATRE_ADMIN,
  ROLE.SUPER_ADMIN,
  "THEATER_ADMIN", // accepted spelling, normalized → THEATRE_ADMIN
];

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
        if (val === "THEATER_ADMIN") return ROLE.THEATRE_ADMIN;
        return val;
      },
      get: (v) => v,
    },

    // canonical stored field (British spelling) — keep as the real schema path
    theatreId: { type: mongoose.Schema.Types.ObjectId, ref: "Theater", default: null },

    // NOTE: password is select:false by default. Authentication lookup must request +password.
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
        // remove sensitive/internal fields
        delete ret.password;
        delete ret.__v;

        // ensure both variants are present in JSON output for compatibility
        // prefer canonical theatreId (real path), but expose both keys
        ret.theatreId = ret.theatreId ?? ret.theaterId ?? null;
        ret.theaterId = ret.theaterId ?? ret.theatreId ?? null;

        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.__v;
        ret.theatreId = ret.theatreId ?? ret.theaterId ?? null;
        ret.theaterId = ret.theaterId ?? ret.theatreId ?? null;
        return ret;
      },
    },
  }
);

/* ------------------------------ Virtuals & helpers ----------------------------- */

// Only create the alias virtual "theaterId" (american spelling).
// DO NOT create a virtual called "theatreId" because that's a real path in the schema.

userSchema
  .virtual("theaterId")
  .get(function () {
    try {
      const raw = this._doc || {};
      return raw.theatreId ?? raw.theaterId ?? null;
    } catch {
      return null;
    }
  })
  .set(function (val) {
    try {
      // write canonical field and mirror onto _doc to keep in-memory shape
      if (typeof this.set === "function") this.set("theatreId", val);
      if (!this._doc) this._doc = {};
      this._doc.theatreId = val;
      this._doc.theaterId = val;
    } catch (e) {
      // noop
    }
  });

/* ------------------------------- Password hooks -------------------------------- */

// Hash password on save when modified
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

/**
 * Handle findOneAndUpdate / findByIdAndUpdate cases.
 * We attempt to find password either directly on the update object or inside $set.
 *
 * Examples of update shapes:
 *  - { password: "new" }
 *  - { $set: { password: "new" } }
 *  - { $set: { other: 1 } } (no password)
 */
userSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const update = this.getUpdate && (this.getUpdate() || {});
    if (!update) return next();

    // support both direct set and $set
    const rawPassword =
      update.password !== undefined
        ? update.password
        : update.$set && update.$set.password !== undefined
        ? update.$set.password
        : undefined;

    if (rawPassword !== undefined && rawPassword !== null && rawPassword !== "") {
      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(String(rawPassword), salt);

      // place hashed password back into the same shape it was found
      if (update.password !== undefined) {
        update.password = hashed;
      } else if (update.$set && update.$set.password !== undefined) {
        update.$set.password = hashed;
      } else {
        // as a fallback write into $set
        update.$set = update.$set || {};
        update.$set.password = hashed;
      }

      // write back the update object
      this.setUpdate(update);
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- Instance helpers -------------------------------- */

userSchema.methods.compare = async function (enteredPassword) {
  // Defensive: when model was loaded without password (select:false) this.password will be undefined.
  // Callers (e.g. auth service) should request the password with .select("+password").
  if (!this.password) {
    // explicit, friendly error to help debug auth path mistakes
    throw new Error(
      "Password not available on this document. Use Model.findOne(...).select('+password') or use the provided static helper."
    );
  }
  return bcrypt.compare(enteredPassword, this.password);
};

/* ------------------------------- Static helpers -------------------------------- */

/**
 * Convenience: find by email and include password for auth flows.
 * Use this in your auth/login code so you won't forget to select the password.
 *
 * Example:
 *   const user = await User.findByEmailWithPassword(email);
 *   if (!user) throw ...
 *   const ok = await user.compare(plainPassword);
 */
userSchema.statics.findByEmailWithPassword = function (email) {
  return this.findOne({ email: String(email).toLowerCase().trim() }).select("+password");
};

/* ------------------------------- Export model ---------------------------------- */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
