// src/routes/payments.routes.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Razorpay from "razorpay";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Express router
const router = express.Router();

// Log confirmation when module loads
console.log("🚀 payments.routes.js loaded (enhanced version)");

// ---------------------------------------------------------------------------
// Razorpay Initialization (Safe)
// ---------------------------------------------------------------------------
let razorpay = null;
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (keyId && keySecret) {
  try {
    razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    console.log("✅ Razorpay initialized successfully");
  } catch (err) {
    console.warn("⚠️ Razorpay init failed:", err.message || err);
    razorpay = null;
  }
} else {
  console.warn("⚠️ Missing Razorpay keys in .env file");
}

// ---------------------------------------------------------------------------
// Health Check Route
// ---------------------------------------------------------------------------
router.get("/test", (req, res) => res.send("✅ Payments route active"));

// ---------------------------------------------------------------------------
// Create Order Route (with support for full amount calculation)
// ---------------------------------------------------------------------------
router.post("/create-order", async (req, res) => {
  try {
    const { amount, base, convFee, gst, currency = "INR" } = req.body;

    // Compute the total amount safely
    let total = 0;
    if (amount) {
      total = Number(amount);
    } else if (base) {
      total = Number(base || 0) + Number(convFee || 0) + Number(gst || 0);
    }

    if (!total || isNaN(total) || total <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid total amount" });
    }

    // Convert to paise (₹373.50 → 37350)
    const amountPaise = Math.round(total * 100);
    console.log(`💰 Creating order for ₹${total.toFixed(2)} (${amountPaise} paise)`);

    // Create real or fake order
    if (razorpay) {
      const order = await razorpay.orders.create({
        amount: amountPaise,
        currency,
        receipt: "rcpt_" + Date.now(),
        payment_capture: 1,
      });

      console.log("✅ Razorpay Order Created:", order.id);
      return res.json({
        ok: true,
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        total,
      });
    } else {
      const fakeOrder = {
        id: "order_dev_" + Date.now(),
        amount: amountPaise,
        currency,
        total,
      };
      console.log("⚙️ Returning fake order (dev):", fakeOrder.id);
      return res.json({ ok: true, ...fakeOrder });
    }
  } catch (err) {
    console.error("[create-order Error]", err?.error || err);
    return res.status(500).json({
      ok: false,
      error: "Failed to create order",
      details: err?.error || err?.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Verify Payment Route
// ---------------------------------------------------------------------------
router.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, message: "Missing required parameters" });
    }

    if (!keySecret) {
      return res.status(400).json({ ok: false, message: "Server missing Razorpay key secret" });
    }

    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected === razorpay_signature) {
      console.log("✅ Payment verified:", razorpay_order_id);
      // TODO: Mark order as paid in your DB here
      return res.json({ ok: true, message: "Payment verified successfully" });
    } else {
      console.warn("❌ Invalid signature for order:", razorpay_order_id);
      return res.status(400).json({ ok: false, message: "Invalid signature" });
    }
  } catch (err) {
    console.error("[verify-payment Error]", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ---------------------------------------------------------------------------
// Mock Payment (Dev only)
// ---------------------------------------------------------------------------
router.post("/mock-success", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ ok: false, error: "Disabled in production" });
  }

  const { orderId, amount } = req.body;
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
