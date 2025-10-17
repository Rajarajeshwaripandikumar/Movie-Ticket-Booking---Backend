// src/routes/payments.routes.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Razorpay from "razorpay";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const router = express.Router();
console.log("🚀 payments.routes.js loaded (final fixed version)");

// ---------------------------------------------------------------------------
// Razorpay Initialization
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
router.get("/test", (_req, res) => res.send("✅ Payments route active"));

// ---------------------------------------------------------------------------
// Create Order Route
// ---------------------------------------------------------------------------
router.post("/create-order", async (req, res) => {
  try {
    const { amount, base, convFee, gst, currency = "INR", showtimeId } = req.body;
    console.log("💡 Received /create-order body:", req.body);

    // -------------------- Compute total safely --------------------
    let total = 0;

    // Prefer full breakdown if provided
    if (base !== undefined || convFee !== undefined || gst !== undefined) {
      total =
        (Number(base) || 0) +
        (Number(convFee) || 0) +
        (Number(gst) || 0);
      console.log(`🧾 Calculated from breakdown: base=${base}, fee=${convFee}, gst=${gst} => total=${total}`);
    } else {
      total = Number(amount) || 0;
      console.log(`🧾 Using direct amount from client: total=${total}`);
    }

    // Validate
    if (!total || isNaN(total) || total <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid total amount" });
    }

    // Convert ₹ to paise
    const amountPaise = Math.round(total * 100);
    console.log(`💰 Final total for Razorpay: ₹${total.toFixed(2)} (${amountPaise} paise)`);

    // -------------------- Create order --------------------
    if (!razorpay) {
      const fakeOrder = {
        id: "order_dev_" + Date.now(),
        amount: amountPaise,
        currency,
        total,
      };
      console.log("⚙️ Dev mode: returning fake order", fakeOrder.id);
      return res.json({ ok: true, ...fakeOrder });
    }

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency,
      receipt: "rcpt_" + Date.now(),
      notes: { showtimeId, total },
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
// Verify Payment
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
      console.log("✅ Payment verified successfully:", razorpay_order_id);
      return res.json({ ok: true, message: "Payment verified successfully" });
    } else {
      console.warn("❌ Invalid Razorpay signature for:", razorpay_order_id);
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
