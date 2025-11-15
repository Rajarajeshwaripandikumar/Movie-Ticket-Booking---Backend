// backend/src/models/Notification.js
import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    // Target audience type:
    audience: {
      type: String,
      enum: ["USER", "THEATER_USERS", "THEATER_ADMIN", "ADMIN", "ALL"],
      default: "USER",
      index: true,
    },

    /**
     * Who should receive this?
     *
     * USER               → specific user only
     * THEATER_USERS      → all users who booked in this theater
     * THEATER_ADMIN      → specific theater admin
     * ADMIN              → all super-admins
     * ALL                → everyone
     */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    theater: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Theater",
      default: null,
      index: true,
    },

    type: {
      type: String,
      enum: [
        "BOOKING_CONFIRMED",
        "BOOKING_CANCELLED",
        "BOOKING_REMINDER",
        "SHOWTIME_CHANGED",
        "UPCOMING_MOVIE",
        "PAYMENT_FAILED",
        "PAYMENT_SUCCEEDED",
        "SYSTEM_ALERT",
        "ADMIN_MESSAGE",
      ],
      required: true,
    },

    title: { type: String, default: "" },
    message: { type: String, default: "" },

    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    channels: {
      type: [String],
      enum: ["IN_APP", "EMAIL", "SMS", "PUSH"],
      default: ["IN_APP"],
    },

    // Read tracking:
    readBy: {
      type: [String], // userId as string or "SUPER_ADMIN"
      default: [],
    },

    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/*                                   INDEXES                                   */
/* -------------------------------------------------------------------------- */

// Fetch notifications fast for user-specific, theater-specific and global
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ theater: 1, createdAt: -1 });
notificationSchema.index({ audience: 1, createdAt: -1 });

// Send reminders efficiently (e.g. cron: upcoming bookings)
notificationSchema.index({ sentAt: 1 });

export default mongoose.model("Notification", notificationSchema);
