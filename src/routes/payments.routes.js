// backend/src/routes/payments.routes.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Razorpay from "razorpay";
import crypto from "crypto";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import Order from "../models/Order.js"; // optional persistence

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
console.log("🚀 payments.routes.js loaded (ESM-safe)");

/* ----------------------------- Config helpers ---------------------------- */
const PERSIST_RZP_ORDERS = (process.env.PERSIST_RZP_ORDERS || "false") === "true";

function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  try {
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
  } catch (err) {
    console.warn("⚠️ Razorpay init failed:", err?.message || err);
    return null;
  }
}

/* ------------------------------- Utilities ------------------------------- */
function okJson(payload = {}) {
  return { ok: true, ...payload };
}
function errJson(message, details) {
  return { ok: false, error: message, details };
}

function computeTotalFromBreakdown({ base, convFee, gst, amount }) {
  if (base !== undefined || convFee !== undefined || gst !== undefined) {
    return (Number(base) || 0) + (Number(convFee) || 0) + (Number(gst) || 0);
  }
  return Number(amount || 0);
}

/* ------------------------------- Routes --------------------------------- */

/** GET /test */
router.get("/test", (_req, res) => res.json(okJson({ message: "Payments route active" })));

/**
 * POST /create-order
 * - Protected by requireAuth by default (recommended).
 * - Expects body: { amount | base, convFee, gst, currency, showtimeId, meta }
 * - Header: X-Idempotency-Key (optional) to avoid duplicate orders
 */
router.post("/create-order", requireAuth, async (req, res) => {
  try {
    const idemKey = (req.headers["x-idempotency-key"] || "").trim() || null;
    const actorUserId = req.user?._id ? String(req.user._id) : null;

    const { amount, base, convFee, gst, currency = "INR", showtimeId, meta = {} } = req.body ?? {};

    const total = computeTotalFromBreakdown({ base, convFee, gst, amount });
    if (!total || isNaN(total) || total <= 0) {
      return res.status(400).json(errJson("Invalid total amount"));
    }
    const amountPaise = Math.round(total * 100);

    const razorpay = getRazorpayInstance();
    if (!razorpay) {
      // Dev fallback: return a fake order and (optionally) persist locally
      const fakeOrder = {
        id: `order_dev_${Date.now()}`,
        amount: amountPaise,
        currency,
        total,
        receipt: `rcpt_dev_${Date.now()}`,
        notes: { showtimeId, ...meta },
      };

      if (PERSIST_RZP_ORDERS) {
        try {
          await Order.create({
            user: actorUserId ? mongoose.Types.ObjectId(actorUserId) : undefined,
            movieId: meta.movieId ? mongoose.Types.ObjectId(meta.movieId) : undefined,
            showtimeId: showtimeId ? mongoose.Types.ObjectId(showtimeId) : undefined,
            seats: meta.seats || [],
            amount: total,
            paymentId: fakeOrder.id,
            status: "PENDING",
            meta: { provider: "dev", raw: meta, idempotencyKey: idemKey },
          });
        } catch (e) {
          console.warn("[payments] failed to persist fake order:", e?.message || e);
        }
      }

      return res.json(okJson({ order: fakeOrder, idempotencyKey: idemKey || null }));
    }

    // If idempotency key provided, check whether a local order with same idempotency exists (if persistence enabled)
    if (idemKey && PERSIST_RZP_ORDERS) {
      const found = await Order.findOne({ "meta.idempotencyKey": idemKey, "meta.provider": "razorpay" }).lean();
      if (found) return res.json(okJson({ order: { id: found.paymentId || found._id }, persisted: true }));
    }

    // Create order at Razorpay
    const created = await razorpay.orders.create({
      amount: amountPaise,
      currency,
      receipt: "rcpt_" + Date.now(),
      notes: { showtimeId, ...meta },
      payment_capture: 1,
    });

    // Optionally persist razorpay order mapping locally (helpful for reconciliation)
    if (PERSIST_RZP_ORDERS) {
      try {
        await Order.create({
          user: actorUserId ? mongoose.Types.ObjectId(actorUserId) : undefined,
          movieId: meta.movieId ? mongoose.Types.ObjectId(meta.movieId) : undefined,
          showtimeId: showtimeId ? mongoose.Types.ObjectId(showtimeId) : undefined,
          seats: meta.seats || [],
          amount: total,
          paymentId: created.id,
          status: "PENDING",
          meta: { provider: "razorpay", raw: meta, idempotencyKey: idemKey, rzpOrder: created },
        });
      } catch (e) {
        console.warn("[payments] failed to persist razorpay order:", e?.message || e);
      }
    }

    return res.json(okJson({ order: { id: created.id, amount: created.amount, currency: created.currency }, total, idempotencyKey: idemKey }));
  } catch (err) {
    console.error("[create-order] Error:", err?.error || err);
    return res.status(500).json(errJson("Failed to create order", err?.message || String(err)));
  }
});

/**
 * POST /verify-payment
 * Standard Razorpay signature verification.
 * Expects body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
router.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json(errJson("Missing required parameters"));
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      console.warn("⚠️ verify-payment: missing RAZORPAY_KEY_SECRET in env");
      return res.status(500).json(errJson("Server missing Razorpay key secret"));
    }

    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected === razorpay_signature) {
      console.log("✅ Payment verified:", razorpay_order_id);
      return res.json(okJson({ message: "Payment verified successfully" }));
    } else {
      console.warn("❌ Invalid Razorpay signature:", razorpay_order_id);
      return res.status(400).json(errJson("Invalid signature"));
    }
  } catch (err) {
    console.error("[verify-payment] Error:", err);
    return res.status(500).json(errJson("Server error", String(err)));
  }
});

/**
 * POST /mock-success
 * Dev-only: returns a fake payment capture object
 */
router.post("/mock-success", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json(errJson("Disabled in production"));
  }

  const { orderId, amount } = req.body ?? {};
  if (!orderId) return res.status(400).json(errJson("orderId required"));

  const fakePayment = {
    id: "dev_pay_" + Date.now(),
    order_id: orderId,
    status: "captured",
    amount: amount || 0,
    currency: "INR",
    created_at: new Date(),
  };

  console.log("⚙️ Mock payment created for", orderId);
  return res.json(okJson({ payment: fakePayment }));
});

export default router;
