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

/* ------------------------------ Virtuals & helpers (FIXED) ----------------------------- */

// Only create the alias virtual "theaterId" (american spelling).
// DO NOT create a virtual called "theatreId" because that's a real path in the schema.

userSchema.virtual("theaterId").get(function () {
  try {
    // read underlying raw fields only (avoid invoking other virtuals)
    const raw = this._doc || {};
    return raw.theatreId ?? raw.theaterId ?? null;
  } catch {
    return null;
  }
}).set(function (val) {
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

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate?.() || {};
  if (update.password) {
    const salt = await bcrypt.genSalt(10);
    update.password = await bcrypt.hash(update.password, salt);
    this.setUpdate(update);
  }
  next();
});

userSchema.methods.compare = async function (enteredPassword) {
  // Defensive: if called on a lean object this method won't exist; callers who used .lean()
  // should instead call bcrypt.compare directly against the hash.
  return bcrypt.compare(enteredPassword, this.password);
};

/* ------------------------------- Export model ---------------------------------- */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
