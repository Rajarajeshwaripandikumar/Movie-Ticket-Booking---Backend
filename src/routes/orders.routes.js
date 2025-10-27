// backend/src/routes/orders.routes.js
import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";

const router = express.Router();

// Create order (public for testing; protect with auth in prod)
router.post("/", async (req, res) => {
  try {
    // Accept either objectId strings or ObjectId values
    const { user, movieId, showtimeId, seats = [], amount, paymentId, status } = req.body;
    if (!user || !movieId || !showtimeId || !amount) {
      return res.status(400).json({ error: "missing required fields (user, movieId, showtimeId, amount)" });
    }

    const order = new Order({
      user: mongoose.Types.ObjectId(user),
      movieId: mongoose.Types.ObjectId(movieId),
      showtimeId: mongoose.Types.ObjectId(showtimeId),
      seats,
      amount: Number(amount),
      paymentId,
      status: status || "CONFIRMED"
    });

    const saved = await order.save();
    return res.status(201).json({ success: true, order: saved });
  } catch (err) {
    console.error("create order error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// List orders (admin)
router.get("/", async (req, res) => {
  try {
    const rows = await Order.find().populate("movieId", "title").sort({ createdAt: -1 }).limit(200);
    res.json(rows);
  } catch (err) {
    console.error("list orders error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Example payment-success webhook (inline)
router.post("/payment-success", async (req, res) => {
  try {
    // Example payload: { user, movieId, showtimeId, seats, amount, paymentId }
    const { user, movieId, showtimeId, seats = [], amount, paymentId } = req.body;
    // TODO: verify payment signature with provider before saving in production
    const order = new Order({
      user: mongoose.Types.ObjectId(user),
      movieId: mongoose.Types.ObjectId(movieId),
      showtimeId: mongoose.Types.ObjectId(showtimeId),
      seats,
      amount: Number(amount),
      paymentId,
      status: "CONFIRMED"
    });
    await order.save();
    res.json({ success: true, orderId: order._id });
  } catch (err) {
    console.error("payment-success error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
