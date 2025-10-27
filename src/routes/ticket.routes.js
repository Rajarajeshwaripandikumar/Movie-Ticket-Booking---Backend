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
import { sendEmail, renderTemplate, createTicketUrls } from "../models/mailer.js";

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
    // 🌐 Resolve PUBLIC URLs (env-first; production fallback)
    // -------------------------
    const FRONTEND_PUBLIC_BASE =
      process.env.APP_PUBLIC_BASE ||
      process.env.FRONTEND_PUBLIC_BASE ||
      process.env.VITE_APP_BASE_URL ||
      process.env.URL || // Netlify
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ||
      (process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : undefined) ||
      "https://movie-ticket-booking-rajy.netlify.app"; // production fallback

    const BACKEND_PUBLIC_BASE =
      process.env.BACKEND_PUBLIC_BASE ||
      process.env.BACKEND_URL ||
      process.env.API_BASE ||
      (process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : undefined) ||
      "https://movie-ticket-booking-backend-o1m2.onrender.com"; // production fallback

    console.log(
      "[tickets.download] FRONTEND_PUBLIC_BASE=%s BACKEND_PUBLIC_BASE=%s bookingId=%s",
      FRONTEND_PUBLIC_BASE,
      BACKEND_PUBLIC_BASE,
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
      { outDir, baseUrl: FRONTEND_PUBLIC_BASE, filename }
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
      // Build canonical URLs (will prefer env vars from mailer.createTicketUrls and will rewrite localhost)
      const { ticketPdfUrl, ticketViewUrl } = createTicketUrls({
        bookingId: booking._id.toString(),
        // token: optionalTokenIfYouGenerateOneFor PDF auth
      });

      // Safe fallback: if PDF link still contains "localhost", use BACKEND_PUBLIC_BASE
      const safePdfLink =
        ticketPdfUrl && !/localhost|127\.0\.0\.1/i.test(ticketPdfUrl)
          ? ticketPdfUrl
          : `${String(BACKEND_PUBLIC_BASE).replace(/\/$/, "")}/tickets/${booking._id}/download`;

      const safeViewLink =
        ticketViewUrl && !/localhost|127\.0\.0\.1/i.test(ticketViewUrl)
          ? ticketViewUrl
          : `${String(FRONTEND_PUBLIC_BASE).replace(/\/$/, "")}/bookings/${booking._id}`;

      console.log(
        "[tickets.download] built links -> pdf=%s view=%s (email=%s)",
        safePdfLink,
        safeViewLink,
        emailTo
      );

      // Prefer to use renderTemplate("ticket", ...) if you have it; otherwise build a simple HTML email
      let html;
      try {
        // If you already have a "ticket" template in mailer.js, this will be used.
        html = renderTemplate("ticket", {
          name: booking.user?.name || "Guest User",
          movieName,
          theaterName: booking.showtime?.screen?.name || "Unknown Theater",
          showDate: booking.showtime?.date
            ? new Date(booking.showtime.date).toLocaleDateString()
            : "N/A",
          showTime: booking.showtime?.time || "N/A",
          seatNumber: booking.seatNumber || "N/A",
          pdfLink: safePdfLink,
          viewLink: safeViewLink,
        });
      } catch (err) {
        // Fallback inline template (simple)
        console.warn("[tickets.download] renderTemplate('ticket') missing or failed, using fallback template", err?.message);
        html = `
          <div style="font-family:sans-serif;background:#f9fafb;padding:20px;">
            <div style="max-width:600px;margin:auto;background:#fff;padding:25px;border-radius:10px;">
              <h2 style="color:#2563eb;">🎟️ Booking Confirmed</h2>
              <p>Hello <b>${booking.user?.name || "Guest User"}</b>,</p>
              <p>Your booking for <b>${movieName}</b> has been confirmed.</p>
              <p><b>Seats:</b> ${booking.seatNumber || "N/A"}</p>
              <p><b>Booking ID:</b> ${booking._id}</p>
              <p><a href="${safePdfLink}" style="background:#2563eb;color:#fff;padding:10px 15px;text-decoration:none;border-radius:6px;">Download Ticket</a></p>
              <p>You can also view your booking here:<br><a href="${safeViewLink}">${safeViewLink}</a></p>
              <hr style="margin:25px 0;">
              <p style="font-size:13px;color:#555;">Thank you for booking with Cineme by Site!</p>
            </div>
          </div>
        `;
      }

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
              meta: { ...notif.meta, previewUrl: result?.previewUrl || null },
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
    // 📤 Stream or send the PDF to user (download response)
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
