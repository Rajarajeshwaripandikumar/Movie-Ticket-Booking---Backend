// backend/src/models/NotificationPref.js
import mongoose from "mongoose";

/**
 * Helper schema for channel options.
 */
const channelSchema = new mongoose.Schema(
  {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    push: { type: Boolean, default: false },
  },
  { _id: false }
);

const prefSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      unique: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["USER", "THEATER_ADMIN", "SUPER_ADMIN"],
      default: "USER",
    },

    /* ---------------------------------------------------------------------- */
    /*                            USER NOTIFICATION PREFS                     */
    /* ---------------------------------------------------------------------- */

    bookingConfirmed: { type: channelSchema, default: () => ({}) },
    bookingCancelled: { type: channelSchema, default: () => ({}) },
    bookingReminder: { type: channelSchema, default: () => ({}) },

    showtimeChanged: { type: channelSchema, default: () => ({}) },
    upcomingMovie: { type: channelSchema, default: () => ({ email: false }) },

    paymentFailed: { type: channelSchema, default: () => ({ email: true }) },
    paymentSucceeded: { type: channelSchema, default: () => ({}) },

    /* ---------------------------------------------------------------------- */
    /*                          THEATER ADMIN NOTIFICATIONS                   */
    /* ---------------------------------------------------------------------- */

    adminShowtimeAlerts: {
      type: channelSchema,
      default: () => ({ email: true, inApp: true }),
    },

    lowOccupancyReport: {
      type: channelSchema,
      default: () => ({ email: true, inApp: true }),
    },

    dailySalesReport: {
      type: channelSchema,
      default: () => ({ email: true, inApp: true }),
    },

    /* ---------------------------------------------------------------------- */
    /*                         SUPER ADMIN NOTIFICATIONS                      */
    /* ---------------------------------------------------------------------- */

    systemAlert: {
      type: channelSchema,
      default: () => ({ email: true, inApp: true }),
    },

    newTheaterRequest: {
      type: channelSchema,
      default: () => ({ email: true }),
    },

    errorLogAlert: {
      type: channelSchema,
      default: () => ({ email: true }),
    },

    /* ---------------------------------------------------------------------- */
    /*                              GLOBAL SETTINGS                            */
    /* ---------------------------------------------------------------------- */

    timezone: { type: String, default: "Asia/Kolkata" },
    emailEnabled: { type: Boolean, default: true },
    pushEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model("NotificationPref", prefSchema);
