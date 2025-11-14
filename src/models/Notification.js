// backend/src/models/Notification.js
import mongoose from "mongoose";

const Schema = mongoose.Schema;

/* ==========================================================================
   NOTIFICATION SCHEMA
   Supports:
   - User-specific notifications
   - Admin notifications
   - Global "ALL" audience notifications
   - Rich payload + multiple channels
   - Mark-as-read (single or multi-user)
   ========================================================================== */

const notificationSchema = new Schema(
  {
    /* ---------------------------- Recipient binding ---------------------------- */

    // USER-only notifications. Optional because admins + ALL may not have a user.
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null, // previously required → now optional for ADMIN/ALL
      index: true,
    },

    // Audience:
    // USER  → Only that specific user
    // ADMIN → All admins / theatre-admins
    // ALL   → All users + admins
    audience: {
      type: String,
      enum: ["USER", "ADMIN", "ALL"],
      default: "USER",
      index: true,
    },

    /* ------------------------------- Meta fields ------------------------------- */

    type: {
      type: String,
      required: true,
      enum: [
        // BOOKING
        "BOOKING_CONFIRMED",
        "BOOKING_CANCELLED",
        "BOOKING_REMINDER",

        // CONTENT / SYSTEM UPDATES
        "SHOWTIME_CHANGED",
        "UPCOMING_MOVIE",

        // PAYMENTS
        "PAYMENT_FAILED",
        "PAYMENT_SUCCEEDED",
      ],
    },

    title: { type: String, default: "" },
    message: { type: String, default: "" },

    data: {
      type: Object,
      default: {},
    },

    /* ----------------------------- Delivery channels --------------------------- */

    channels: {
      type: [String],
      enum: ["IN_APP", "EMAIL", "SMS", "PUSH"],
      default: ["IN_APP"],
    },

    /* ------------------------------- Read tracking ----------------------------- */

    // For user-specific notifications
    readAt: { type: Date, default: null },

    // Multi-reader array (admin dashboards etc.)
    // Stores strings: userId OR "admin" OR any consumer identifier
    readBy: {
      type: [String],
      default: [],
    },

    // If sent externally (email/sms), record timestamp
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* ==========================================================================
   INDEXES
   ========================================================================== */

// Fast lookup by user
notificationSchema.index({ user: 1, createdAt: -1 });

// Fast lookup by audience group
notificationSchema.index({ audience: 1, createdAt: -1 });

// When looking for unread user notifications
notificationSchema.index({ user: 1, readAt: 1 });

/* ==========================================================================
   METHODS
   ========================================================================== */

/** Mark a single-user notification as read */
notificationSchema.methods.markRead = async function (readerId = null) {
  if (this.audience === "USER") {
    this.readAt = new Date();
  }
  if (readerId) {
    if (!this.readBy.includes(readerId)) {
      this.readBy.push(readerId);
    }
  }
  await this.save();
  return this;
};

/** Mark a notification as read by a specific admin/user (multi-read) */
notificationSchema.methods.markReadBy = async function (id) {
  if (!id) return this;
  if (!this.readBy.includes(id)) {
    this.readBy.push(id);
    await this.save();
  }
  return this;
};

/* ==========================================================================
   STATIC HELPERS
   ========================================================================== */

/** Mark all notifications for a user as read */
notificationSchema.statics.markAllForUser = async function (userId) {
  return this.updateMany(
    { user: userId, readAt: null },
    { $set: { readAt: new Date() } }
  );
};

/** Mark all admin notifications as read for a specific admin */
notificationSchema.statics.markAllForAdmin = async function (adminId) {
  return this.updateMany(
    {
      audience: "ADMIN",
      readBy: { $ne: adminId },
    },
    { $push: { readBy: adminId } }
  );
};

/* ==========================================================================
   EXPORT
   ========================================================================== */
export default mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
