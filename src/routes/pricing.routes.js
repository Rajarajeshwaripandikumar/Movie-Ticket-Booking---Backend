import express from "express";
import Pricing from "../models/Pricing.js";
import Theater from "../models/Theater.js";
import Screen from "../models/Screen.js";

const router = express.Router();

// Create or update a pricing entry (upsert)
router.post("/", async (req, res) => {
  try {
    const { theaterId, screenId, seatType, price, currency } = req.body;
    if (!theaterId || !screenId || !seatType || typeof price === "undefined") {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const updated = await Pricing.findOneAndUpdate(
      { theaterId, screenId, seatType },
      { price, currency: currency || "INR", updatedAt: new Date() },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(200).json(updated);
  } catch (err) {
    console.error("pricing.post:", err);
    res.status(500).json({ message: err.message });
  }
});

// Get all pricing (optionally filter by theaterId / screenId)
router.get("/", async (req, res) => {
  try {
    const { theaterId, screenId } = req.query;
    const q = {};
    if (theaterId) q.theaterId = theaterId;
    if (screenId) q.screenId = screenId;

    const list = await Pricing.find(q).populate("theaterId screenId");
    res.json(list);
  } catch (err) {
    console.error("pricing.get:", err);
    res.status(500).json({ message: err.message });
  }
});

// Delete pricing entry
router.delete("/:id", async (req, res) => {
  try {
    await Pricing.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
