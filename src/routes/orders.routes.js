// backend/src/routes/orders.routes.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";

import Order from "../models/Order.js";
import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import User from "../models/User.js";

import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js"; // adjust path if single export
import notifyService from "../services/notify.service.js"; // dispatchNotification
import { sendEmail, renderTemplate } from "../models/mailer.js"; // optional email fallback

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Helper utilities                                                            */
/* -------------------------------------------------------------------------- */
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

function parseSeats(seats) {
  // Accept [{row, col}] or ["r:c"] or "1-2,1-3"
  if (!seats) return [];
  if (Array.isArray(seats)) {
    return seats.map((s) => {
      if (typeof s === "string") {
        const m = s.match(/(\d+)[-:](\d+)/);
        if (m) return { row: Number(m[1]), col: Number(m[2]) };
        return null;
      }
      if (typeof s === "object" && s !== null) {
        const r = Number(s.row ?? s.r ?? s[0]);
        const c = Number(s.col ?? s.c ?? s[1]);
        if (Number.isInteger(r) && Number.isInteger(c)) return { row: r, col: c };
      }
      return null;
    }).filter(Boolean);
  }
  if (typeof seats === "string") {
    return seats
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .map((t) => {
        const m = t.match(/(\d+)[-:](\d+)/);
        if (m) return { row: Number(m[1]), col: Number(m[2]) };
        return null;
      })
      .filter(Boolean);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Create order (user) - protected                                              
   - In production you should integrate this with payment initiation (Razorpay checkout order)
   - This endpoint simply saves an order record in PENDING/CART state for later webhook to confirm
*/
router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const idemKey = (req.headers["x-idempotency-key"] || "").trim() || null;

    const { movieId, showtimeId, seats = [], amount, paymentId, status } = req.body || {};
    if (!movieId || !showtimeId || !amount) {
      return res.status(400).json({ ok: false, error: "movieId, showtimeId and amount are required" });
    }
    if (!isValidId(movieId) || !isValidId(showtimeId)) {
      return res.status(400).json({ ok: false, error: "Invalid movieId or showtimeId" });
    }

    // Idempotency: if same idempotency key and user exists, return existing
    if (idemKey) {
      const existing = await Order.findOne({ "meta.idempotencyKey": idemKey, user: userId }).lean();
      if (existing) return res.status(200).json({ ok: true, order: existing, idempotent: true });
    }

    const seatsParsed = parseSeats(seats);

    const order = new Order({
      user: mongoose.Types.ObjectId(userId),
      movieId: mongoose.Types.ObjectId(movieId),
      showtimeId: mongoose.Types.ObjectId(showtimeId),
      seats: seatsParsed,
      amount: Number(amount),
      paymentId: paymentId || null,
      status: status || "PENDING",
      meta: { idempotencyKey: idemKey || null },
    });

    const saved = await order.save();
    return res.status(201).json({ ok: true, order: saved });
  } catch (err) {
    console.error("[orders] create error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to create order" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET / - list orders (admin only)                                             */
/* -------------------------------------------------------------------------- */
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const q = {};
    // optional query filters
    if (req.query.status) q.status = req.query.status;
    if (req.query.userId && isValidId(req.query.userId)) q.user = req.query.userId;

    const rows = await Order.find(q)
      .populate("movieId", "title")
      .populate("showtimeId", "startTime theater screen")
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    res.json({ ok: true, rows });
  } catch (err) {
    console.error("[orders] list error:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to list orders" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /me - current user's orders                                               */
/* -------------------------------------------------------------------------- */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const rows = await Order.find({ user: userId })
      .populate("movieId", "title posterUrl")
      .populate("showtimeId", "startTime theater screen")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ ok: true, rows });
  } catch (err) {
    console.error("[orders] my orders error:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to load orders" });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /payment-success - webhook for payment provider (Razorpay example)      */
/* - Verifies signature if RAZORPAY_SECRET is configured
 * - Creates Order (if not exists) and creates a simple Booking record
 * - Fires notifications for user
 * - Returns 200 to provider after processing
*/
/* Expected body (example):
   {
     orderId: "<local order id or merchant order id>",
     user: "<userId>",
     movieId: "<movieId>",
     showtimeId: "<showtimeId>",
     seats: [{row, col}, ...],
     amount: 12300, // in rupees or smallest currency unit consistent with your storage
     paymentId: "<gateway payment id>",
     provider: "razorpay",
     signature: "<signature>" // optional - provider specific
   }
*/
router.post("/payment-success", async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      user: userId,
      movieId,
      showtimeId,
      seats = [],
      amount,
      paymentId,
      provider = "unknown",
      orderMetaId, // optional merchant order id
      signature,
    } = payload;

    // Basic validation
    if (!userId || !movieId || !showtimeId || !amount || !paymentId) {
      return res.status(400).json({ ok: false, error: "user, movieId, showtimeId, amount, paymentId are required" });
    }
    if (!isValidId(userId) || !isValidId(movieId) || !isValidId(showtimeId)) {
      return res.status(400).json({ ok: false, error: "Invalid object ids" });
    }

    // Optional: verify Razorpay signature if env present
    if (String(provider).toLowerCase() === "razorpay" && process.env.RAZORPAY_SECRET) {
      try {
        // Razorpay typically sends: hmac(secret, order_id|payment_id) in X-Razorpay-Signature or in payload fields
        // We'll support simple scenario: signature in req.body.signature and verify HMAC of paymentId|orderMetaId
        const secret = String(process.env.RAZORPAY_SECRET);
        const toSign = `${orderMetaId || ""}|${paymentId}`; // adapt depending on provider's doc
        const h = crypto.createHmac("sha256", secret).update(toSign).digest("hex");
        if (signature && h !== signature) {
          console.warn("[orders] razorpay signature mismatch", { expected: h, got: signature });
          return res.status(400).json({ ok: false, error: "invalid signature" });
        }
      } catch (sigErr) {
        console.warn("[orders] signature verify failed:", sigErr);
        return res.status(400).json({ ok: false, error: "signature verification failed" });
      }
    }

    // Idempotency: don't create duplicate order for same paymentId
    const existingOrder = await Order.findOne({ paymentId }).lean();
    if (existingOrder) {
      return res.json({ ok: true, message: "Order already recorded", orderId: existingOrder._id });
    }

    // Create order + booking in a transaction if using replica-set; otherwise best-effort
    const session = await mongoose.startSession();
    let createdOrder = null;
    let createdBooking = null;
    try {
      await session.withTransaction(async () => {
        const newOrder = new Order({
          user: mongoose.Types.ObjectId(userId),
          movieId: mongoose.Types.ObjectId(movieId),
          showtimeId: mongoose.Types.ObjectId(showtimeId),
          seats: parseSeats(seats),
          amount: Number(amount),
          paymentId,
          status: "CONFIRMED",
          meta: { provider, orderMetaId: orderMetaId || null },
        });
        createdOrder = await newOrder.save({ session });

        // Create a lightweight Booking doc so bookings analytics and tickets work.
        // If you have a more complex booking flow (seat locks, transactions against showtime),
        // you should replace this with your confirm booking flow that updates showtime.seats.
        const bk = new Booking({
          user: mongoose.Types.ObjectId(userId),
          showtime: mongoose.Types.ObjectId(showtimeId),
          seats: parseSeats(seats),
          amount: Number(amount),
          status: "CONFIRMED",
        });
        createdBooking = await bk.save({ session });
      });
    } catch (txErr) {
      console.error("[orders] transaction failed:", txErr);
      // fallback: attempt to create order outside tx
      try {
        if (!createdOrder) {
          createdOrder = await Order.create({
            user: mongoose.Types.ObjectId(userId),
            movieId: mongoose.Types.ObjectId(movieId),
            showtimeId: mongoose.Types.ObjectId(showtimeId),
            seats: parseSeats(seats),
            amount: Number(amount),
            paymentId,
            status: "CONFIRMED",
            meta: { provider, orderMetaId: orderMetaId || null },
          });
        }
      } catch (fallbackErr) {
        console.error("[orders] fallback create order failed:", fallbackErr);
        return res.status(500).json({ ok: false, error: "Failed to record order" });
      }
    } finally {
      session.endSession();
    }

    // Post-processing: send notification (best-effort)
    try {
      // Use notifyService.dispatchNotification: target is user id
      const notifRes = await notifyService.dispatchNotification(String(userId), {
        type: "BOOKING_CONFIRMED",
        title: "🎟️ Booking Confirmed",
        message: `Your booking is confirmed (Order: ${String(createdOrder?._id || "")}).`,
        data: {
          bookingId: String(createdBooking?._id || ""),
          orderId: String(createdOrder?._id || ""),
          showtimeId,
          seats: parseSeats(seats),
        },
      });

      // Also send an email using your mailer as fallback (notifyService will respect prefs)
      // (no-op if preferences disallow)
      console.log("[orders] notification result:", notifRes?.results || notifRes);
    } catch (notifyErr) {
      console.warn("[orders] notification failed:", notifyErr);
    }

    return res.json({ ok: true, orderId: String(createdOrder._id), bookingId: String(createdBooking._id) });
  } catch (err) {
    console.error("[orders] payment-success error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to process payment webhook" });
  }
});

export default router;
