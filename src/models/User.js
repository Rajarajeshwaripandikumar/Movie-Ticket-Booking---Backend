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

    // canonical stored field (British spelling) — keep as source-of-truth
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

// provide a theaterId alias (american spelling) that reads/writes the same underlying value
userSchema.virtual("theaterId")
  .get(function () {
    return this.theatreId ?? this.theaterId ?? null;
  })
  .set(function (val) {
    // set both to keep older clients and new code working
    this.theatreId = val;
    this.theaterId = val;
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
  return bcrypt.compare(enteredPassword, this.password);
};

/* ------------------------------- Export model ---------------------------------- */
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
