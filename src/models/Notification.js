// models/Notification.js
import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    // user-specific notifications (USER audience)
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // ← was required: true

    // who should see this notification
    audience: {
      type: String,
      enum: ["USER", "ADMIN", "ALL"],
      default: "USER", // old docs become USER automatically
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
        // optional future types:
        "PAYMENT_FAILED",
        "PAYMENT_SUCCEEDED",
      ],
      required: true,
    },

    title: String,
    message: String,
    data: {}, // any payload

    channels: [{ type: String, enum: ["IN_APP", "EMAIL", "SMS", "PUSH"] }],

    // read tracking:
    readAt: Date,          // for simple user-scoped notifications
    readBy: [String],      // multi-reader support: store "admin" or userId strings

    sentAt: Date,
  },
  { timestamps: true }
);

// Helpful indexes
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ audience: 1, createdAt: -1 });

export default mongoose.model("Notification", notificationSchema);
