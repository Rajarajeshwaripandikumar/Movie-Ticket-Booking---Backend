// src/routes/payments.routes.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Razorpay from "razorpay";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load env (adjust path if your .env is elsewhere)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Create router
const router = express.Router();

// immediate log so we know module loaded
console.log("🚀 payments.routes.js loaded (safe)");

// --- Optional: safe Razorpay init (won't crash module) ---
let razorpay = null;
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (keyId && keySecret) {
  try {
    razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    console.log("✅ Razorpay initialized");
  } catch (e) {
    console.warn("⚠️ Razorpay init failed (continuing without it):", e.message || e);
    razorpay = null;
  }
} else {
  console.warn("⚠️ Razorpay keys not found in env (continuing without it)");
}

// --- Minimal test route to confirm router is mounted ---
router.get("/test", (req, res) => res.send("✅ Payments route active"));

// --- create-order: if razorpay available -> create real order, else return fake order (safe fallback) ---
router.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR" } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount" });
    }

    const amountPaise = Math.round(Number(amount) * 100);

    if (razorpay) {
      // real Razorpay order
      const order = await razorpay.orders.create({
        amount: amountPaise,
        currency,
        receipt: "rcpt_" + Date.now(),
        payment_capture: 1,
      });
      console.log("✅ Razorpay Order Created:", order.id);
      return res.json({ ok: true, id: order.id, amount: order.amount, currency: order.currency });
    } else {
      // safe dev fallback (no external call)
      const fakeOrder = { id: "order_dev_" + Date.now(), amount: amountPaise, currency };
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

// --- verify-payment: safe signature verify (works in both real & dev flows) ---
router.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, message: "Missing required parameters" });
    }
    if (!keySecret) {
      return res.status(400).json({ ok: false, message: "Server missing key secret for verification" });
    }
    const expected = crypto.createHmac("sha256", keySecret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
    if (expected === razorpay_signature) {
      // TODO: mark order paid in DB
      return res.json({ ok: true, message: "Payment verified" });
    } else {
      return res.status(400).json({ ok: false, message: "Invalid signature" });
    }
  } catch (err) {
    console.error("[verify-payment Error]", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// --- dev mock (only non-production) ---
router.post("/mock-success", (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(403).json({ ok: false, error: "Disabled in production" });
  const { orderId, amount } = req.body;
  if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });
  const fakePayment = { id: "dev_pay_" + Date.now(), order_id: orderId, status: "captured", amount: amount || 0, currency: "INR", created_at: new Date() };
  console.log("⚙️ Mock payment created for", orderId);
  return res.json({ ok: true, payment: fakePayment });
});

export default router;
