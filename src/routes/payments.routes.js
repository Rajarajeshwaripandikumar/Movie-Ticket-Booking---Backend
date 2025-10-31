// src/routes/payments.routes.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Razorpay from "razorpay";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
console.log("🚀 payments.routes.js loaded (ESM-safe)");

// Lazy Razorpay initializer — avoids top-level throws when env vars missing
function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }
  try {
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
  } catch (err) {
    console.warn("⚠️ Razorpay init failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health Check Route
// ---------------------------------------------------------------------------
router.get("/test", (_req, res) => res.send("✅ Payments route active"));

// ---------------------------------------------------------------------------
// Create Order Route
// ---------------------------------------------------------------------------
router.post("/create-order", async (req, res) => {
  try {
    const { amount, base, convFee, gst, currency = "INR", showtimeId } = req.body ?? {};
    console.log("💡 /create-order body:", { amount, base, convFee, gst, currency, showtimeId });

    // compute total from breakdown if provided, else use amount
    let total = 0;
    if (base !== undefined || convFee !== undefined || gst !== undefined) {
      total = (Number(base) || 0) + (Number(convFee) || 0) + (Number(gst) || 0);
    } else {
      total = Number(amount) || 0;
    }

    if (!total || isNaN(total) || total <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid total amount" });
    }

    const amountPaise = Math.round(total * 100);
    console.log(`💰 Creating order for ₹${total.toFixed(2)} (${amountPaise} paise)`);

    const razorpay = getRazorpayInstance();
    if (!razorpay) {
      // Dev / fallback behaviour
      const fakeOrder = {
        id: "order_dev_" + Date.now(),
        amount: amountPaise,
        currency,
        total,
      };
      console.log("⚙️ Dev/fallback mode: returning fake order", fakeOrder.id);
      return res.json({ ok: true, ...fakeOrder });
    }

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency,
      receipt: "rcpt_" + Date.now(),
      notes: { showtimeId, total },
      payment_capture: 1,
    });

    console.log("✅ Razorpay order created:", order.id);
    return res.json({
      ok: true,
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      total,
    });
  } catch (err) {
    console.error("[create-order] Error:", err?.error || err);
    return res.status(500).json({
      ok: false,
      error: "Failed to create order",
      details: err?.error || err?.message || String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// Verify Payment
// ---------------------------------------------------------------------------
router.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, message: "Missing required parameters" });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      console.warn("⚠️ verify-payment: missing RAZORPAY_KEY_SECRET in env");
      return res.status(500).json({ ok: false, message: "Server missing Razorpay key secret" });
    }

    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected === razorpay_signature) {
      console.log("✅ Payment verified:", razorpay_order_id);
      return res.json({ ok: true, message: "Payment verified successfully" });
    } else {
      console.warn("❌ Invalid Razorpay signature:", razorpay_order_id);
      return res.status(400).json({ ok: false, message: "Invalid signature" });
    }
  } catch (err) {
    console.error("[verify-payment] Error:", err);
    return res.status(500).json({ ok: false, message: "Server error", details: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Mock Payment (Dev only)
// ---------------------------------------------------------------------------
router.post("/mock-success", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ ok: false, error: "Disabled in production" });
  }

  const { orderId, amount } = req.body ?? {};
  if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

  const fakePayment = {
    id: "dev_pay_" + Date.now(),
    order_id: orderId,
    status: "captured",
    amount: amount || 0,
    currency: "INR",
    created_at: new Date(),
  };

  console.log("⚙️ Mock payment created for", orderId);
  return res.json({ ok: true, payment: fakePayment });
});

export default router;
