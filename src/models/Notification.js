// backend/src/models/Notification.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const CHANNELS = ["IN_APP", "EMAIL", "SMS", "PUSH"];
const AUDIENCES = ["USER", "THEATER_USERS", "THEATRE_ADMIN", "THEATER_ADMIN", "ADMIN", "ALL"];
const TYPES = [
  "BOOKING_CONFIRMED",
  "BOOKING_CANCELLED",
  "BOOKING_REMINDER",
  "SHOWTIME_CHANGED",
  "UPCOMING_MOVIE",
  "PAYMENT_FAILED",
  "PAYMENT_SUCCEEDED",
  "SYSTEM_ALERT",
  "ADMIN_MESSAGE",
];

const notificationSchema = new Schema(
  {
    audience: {
      type: String,
      enum: AUDIENCES,
      default: "USER",
      index: true,
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // IMPORTANT: ensure this `ref` matches your registered model name exactly.
    // If your model is registered as mongoose.model("Theatre", ...) then use "Theatre".
    theatreId: {
      type: Schema.Types.ObjectId,
      ref: "Theatre",
      default: null,
      index: true,
    },

    // Backwards-compat / alternate field name. Keep or remove once migrated.
    theater: {
      type: Schema.Types.ObjectId,
      ref: "Theatre",
      default: null,
      index: true,
    },

    booking: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      index: true,
    },

    showtime: {
      type: Schema.Types.ObjectId,
      ref: "Showtime",
      default: null,
      index: true,
    },

    type: {
      type: String,
      enum: TYPES,
      required: true,
    },

    title: { type: String, default: "" },
    message: { type: String, default: "" },

    data: {
      type: Schema.Types.Mixed,
      default: {},
    },

    // explicit array-of-item schema so enum applies to each value
    channels: {
      type: [{ type: String, enum: CHANNELS }],
      default: ["IN_APP"],
    },

    // store user ids who read this notification
    readBy: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },

    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* INDEXES */
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ theatreId: 1, createdAt: -1 });
notificationSchema.index({ audience: 1, createdAt: -1 });
notificationSchema.index({ booking: 1, createdAt: -1 });
notificationSchema.index({ showtime: 1, createdAt: -1 });
notificationSchema.index({ sentAt: 1 });

export default mongoose.model("Notification", notificationSchema);
