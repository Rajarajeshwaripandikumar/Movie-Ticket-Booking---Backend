import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
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
        populate: [{ path: "movie", select: "title" }, { path: "screen", select: "name" }],
      })
      .lean();

    if (!booking) return res.status(404).send("Booking not found");

    // Generate ticket PDF
    const pdfPath = await generateTicketPdf(
      booking,
      booking.user || { name: "Guest User", email: "guest@example.com" },
      booking.showtime
    );

    // Extract recipient details
    const emailTo = booking.user?.email || booking.email;
    const movieName = booking.showtime?.movie?.title || "Unknown Movie";

    // Create a notification entry (initially pending)
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

    // Try to send email
    if (emailTo) {
      const pdfLink = `http://localhost:8080/tickets/${booking._id}/download`;
      const html = renderTemplate("ticket", {
        name: booking.user?.name || "Guest User",
        movieName,
        theaterName: booking.showtime?.screen?.name || "Unknown Theater",
        showDate: new Date(booking.showtime?.date).toLocaleDateString(),
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

        // Update notification on success
        await Notification.updateOne(
          { _id: notif._id },
          {
            $set: {
              "email.status": "sent",
              "email.attempts": 1,
              "email.sentAt": new Date(),
              meta: { ...notif.meta, previewUrl: result.previewUrl },
            },
          }
        );
        console.log("✅ Email sent:", emailTo);
      } catch (err) {
        // Update notification on failure
        await Notification.updateOne(
          { _id: notif._id },
          {
            $set: {
              "email.status": "failed",
              "email.attempts": notif.email.attempts + 1,
              "email.lastError": err.message,
            },
          }
        );
        console.error("❌ Failed to send ticket email:", err.message);
      }
    }

    // Stream the PDF to user
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="ticket-${booking._id}.pdf"`);

    const stream = fs.createReadStream(pdfPath);
    stream.pipe(res);

    stream.on("end", () => fs.unlink(pdfPath, () => {}));
  } catch (err) {
    console.error("❌ Ticket download error:", err);
    res.status(500).send("Failed to generate ticket PDF");
  }
});

export default router;
