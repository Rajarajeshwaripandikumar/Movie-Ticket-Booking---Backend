// src/routes/tickets.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";
import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import Notification from "../models/Notification.js";
import { generateTicketPdf } from "../utils/generateTicketPdf.js";
import { sendEmail, renderTemplate } from "../models/mailer.js";

const router = Router();

router.get("/:bookingId/download", async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId))
      return res.status(400).send("Invalid booking ID");

    const booking = await Booking.findById(bookingId)
      .populate({
        path: "showtime",
        populate: [
          { path: "movie", select: "title" },
          { path: "screen", select: "name" },
        ],
      })
      .lean();

    if (!booking) return res.status(404).send("Booking not found");

    // -------------------------
    // 🌐 Resolve URLs (env-first; with production fallback)
    // -------------------------
    // FRONTEND_URL → used for QR / verify links in PDF
    const FRONTEND_URL =
      process.env.BASE_URL ||
      process.env.APP_BASE_URL ||
      process.env.VITE_APP_BASE_URL ||
      process.env.URL || // Netlify
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ||
      (process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : undefined) ||
      "https://movie-ticket-booking-rajy.netlify.app"; // ✅ production fallback (never localhost)

    // BACKEND_URL → used for direct download link in email
    const BACKEND_URL =
      process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;

    // Debug: log which URLs the server is using
    console.log(
      "[tickets.download] FRONTEND_URL=%s BACKEND_URL=%s bookingId=%s",
      FRONTEND_URL,
      BACKEND_URL,
      bookingId
    );

    // -------------------------
    // 🧾 Generate ticket PDF
    // -------------------------
    const tmpDir = os.tmpdir();
    const outDir = tmpDir;
    const filename = `ticket-${booking._id}-${Date.now()}.pdf`;

    const genResult = await generateTicketPdf(
      booking,
      booking.user || { name: "Guest User", email: "guest@example.com" },
      booking.showtime,
      { outDir, baseUrl: FRONTEND_URL, filename }
    );

    let filepath = null;
    let buffer = null;
    if (genResult?.filepath) filepath = genResult.filepath;
    else if (genResult?.buffer) buffer = genResult.buffer;
    else if (typeof genResult === "string") filepath = genResult;
    else throw new Error("generateTicketPdf returned unexpected result");

    // -------------------------
    // 📨 Create notification
    // -------------------------
    const emailTo = booking.user?.email || booking.email;
    const movieName = booking.showtime?.movie?.title || "Unknown Movie";

    const notif = await Notification.create({
      bookingId,
      email: { to: emailTo || "N/A", status: "pending", attempts: 0 },
      sms: { status: "skipped" },
      meta: {
        movie: movieName,
        seat: booking.seatNumber,
        theater: booking.showtime?.screen?.name,
      },
    });

    // -------------------------
    // 📧 Email the ticket
    // -------------------------
    if (emailTo) {
      const pdfLink = `${String(BACKEND_URL).replace(/\/$/, "")}/tickets/${booking._id}/download`;

      const html = renderTemplate("ticket", {
        name: booking.user?.name || "Guest User",
        movieName,
        theaterName: booking.showtime?.screen?.name || "Unknown Theater",
        showDate: booking.showtime?.date
          ? new Date(booking.showtime.date).toLocaleDateString()
          : "N/A",
        showTime: booking.showtime?.time || "N/A",
        seatNumber: booking.seatNumber || "N/A",
        pdfLink,
      });

      try {
        const result = await sendEmail({
          to: emailTo,
          subject: `🎬 Your Ticket for ${movieName}`,
          html,
        });

        await Notification.updateOne(
          { _id: notif._id },
          {
            $set: {
              "email.status": "sent",
              "email.attempts": 1,
              "email.sentAt": new Date(),
              meta: { ...notif.meta, previewUrl: result?.previewUrl },
            },
          }
        );
        console.log("✅ Email sent:", emailTo);
      } catch (err) {
        await Notification.updateOne(
          { _id: notif._id },
          {
            $set: {
              "email.status": "failed",
              "email.attempts": (notif.email?.attempts || 0) + 1,
              "email.lastError": err?.message || String(err),
            },
          }
        );
        console.error("❌ Failed to send ticket email:", err?.message || err);
      }
    }

    // -------------------------
    // 📤 Stream or send the PDF to user
    // -------------------------
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ticket-${booking._id}.pdf"`
    );

    if (buffer) {
      res.send(buffer);
    } else if (filepath) {
      const stream = fs.createReadStream(filepath);
      stream.pipe(res);
      stream.on("end", () => {
        fs.unlink(filepath, (err) => {
          if (err) console.warn("Failed to unlink temp ticket file:", err);
        });
      });
      stream.on("error", (err) => {
        console.error("Stream error:", err);
        res.status(500).send("Failed to stream ticket");
      });
    } else {
      throw new Error("No PDF output from generator");
    }
  } catch (err) {
    console.error("❌ Ticket download error:", err);
    res.status(500).send("Failed to generate ticket PDF");
  }
});

export default router;
