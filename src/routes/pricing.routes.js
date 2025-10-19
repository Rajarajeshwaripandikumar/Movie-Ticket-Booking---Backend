import express from "express";
import Pricing from "../models/Pricing.js";

const router = express.Router();

// Add or update pricing
router.post("/", async (req, res) => {
  try {
    const { theaterId, screenId, seatType, price } = req.body;
    const updated = await Pricing.findOneAndUpdate(
      { theaterId, screenId, seatType },
      { price, updatedAt: new Date() },
      { new: true, upsert: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all pricing
router.get("/", async (req, res) => {
  try {
    const data = await Pricing.find().populate("theaterId screenId");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
