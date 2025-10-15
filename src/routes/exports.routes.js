// routes/exports.routes.js
import express from "express";
import { Parser } from "json2csv";
import Booking from "../models/Booking.js";
const router = express.Router();

router.get("/reports/revenue.csv", async (req, res) => {
  const data = await Booking.aggregate([
    { $match: { status: "CONFIRMED" } },
    { $addFields: { day: { $dateTrunc: { date: "$createdAt", unit: "day" } } } },
    { $group: { _id: "$day", revenue: { $sum: "$amount" }, bookings: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);
  const parser = new Parser({ fields: ["_id", "revenue", "bookings"] });
  const csv = parser.parse(data);
  res.header("Content-Type", "text/csv");
  res.attachment("revenue.csv");
  res.send(csv);
});

export default router;
