// src/routes/tickets.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import Booking from "../models/Booking.js";
import Showtime from "../models/Showtime.js";
import Notification from "../models/Notification.js";
import { generateTicketPdf } from "../utils/generateTicketPdf.js";
import { sendEmail, renderTemplate, createTicketUrls } from "../models/mailer.js";

const router = Router();

/**
 * Helper: extract token from Authorization header or query param and decode it.
 * Returns { userId, role, theatreId } or { userId: null, role: null } on failure.
 */
function decodeAuth(req) {
  const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
  const header = req.headers?.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : req.query?.token || null;
  if (!token) return { userId: null, role: null, theatreId: null, rawToken: null };

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.sub || decoded.id || decoded.userId || decoded._id || null;
    const roleRaw =
      decoded.role ||
      (Array.isArray(decoded.roles) && decoded.roles.find((r) => String(r).toUpperCase().includes("ADMIN"))) ||
      null;
    const role = roleRaw ? String(roleRaw).toUpperCase() : null;
    const theatreId = decoded.theatreId || decoded.theaterId || decoded.theatre || decoded.theater || null;
    return { userId: userId ? String(userId) : null, role, theatreId: theatreId ? String(theatreId) : null, rawToken: token };
  } catch (err) {
    // invalid token
    return { userId: null, role: null, theatreId: null, rawToken: null };
  }
}

/**
 * GET /:bookingId/download
 * - Access rules:
 *    * SUPER_ADMIN -> allowed
 *    * THEATRE_ADMIN -> allowed if booking.showtime.theater === token.theatreId (token must include theatreId)
 *    * USER -> allowed if booking.user === token.userId
 * - Accepts token via Bearer header or ?token=... query param (for emailed links).
 */
router.get("/:bookingId/download", async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId)) return res.status(400).send("Invalid booking ID");

    // decode auth/token if present
    const auth = decodeAuth(req);

    // fetch booking + populated showtime/movie/screen
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

    // Determine access
    const bookingUserId = booking.user ? String(booking.user) : null;
    const showtimeTheaterId = booking.showtime?.theater ? String(booking.showtime.theater) : null;

    const role = auth.role || null;
    const requesterId = auth.userId || null;
    const requesterTheatreId = auth.theatreId || null;

    // If no token/header provided, require a logged-in user via cookie/session — but this route handles token-based auth only.
    // For safety, we treat missing auth as unauthorized.
    if (!requesterId && !role) {
      return res.status(401).send("Unauthorized: missing token");
    }

    const isSuper = role === "SUPER_ADMIN";
    const isTheatreAdmin = role === "THEATRE_ADMIN";
    const isOwner = requesterId && bookingUserId && requesterId === bookingUserId;

    // Allow if owner
    let allowed = false;
    if (isSuper) allowed = true;
    else if (isOwner) allowed = true;
    else if (isTheatreAdmin && requesterTheatreId && showtimeTheaterId && requesterTheatreId === String(showtimeTheaterId)) {
      allowed = true;
    }

    if (!allowed) {
      return res.status(403).send("Forbidden: you are not allowed to download this ticket");
    }

    // -------------------------
    // 🌐 Resolve PUBLIC URLs (env-first; production fallback)
    // -------------------------
    const FRONTEND_PUBLIC_BASE =
      process.env.APP_PUBLIC_BASE ||
      process.env.FRONTEND_PUBLIC_BASE ||
      process.env.VITE_APP_BASE_URL ||
      process.env.URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ||
      (process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : undefined) ||
      "https://movie-ticket-booking-rajy.netlify.app";

    const BACKEND_PUBLIC_BASE =
      process.env.BACKEND_PUBLIC_BASE ||
      process.env.BACKEND_URL ||
      process.env.API_BASE ||
      (process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : undefined) ||
      "https://movie-ticket-booking-backend-o1m2.onrender.com";

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
    // 📧 Email the ticket (if email exists)
    // -------------------------
    if (emailTo) {
      // Build canonical URLs (pass through token if present so emailed links work)
      const tokenToAttach = auth.rawToken || undefined;
      const { ticketPdfUrl, ticketViewUrl } = createTicketUrls({
        bookingId: booking._id.toString(),
        token: tokenToAttach,
      });

      // Safe fallback: if PDF link still contains "localhost", use BACKEND_PUBLIC_BASE
      const safePdfLink =
        ticketPdfUrl && !/localhost|127\.0\.0\.1/i.test(ticketPdfUrl)
          ? ticketPdfUrl
          : `${String(BACKEND_PUBLIC_BASE).replace(/\/$/, "")}/tickets/${booking._id}/download${tokenToAttach ? `?token=${tokenToAttach}` : ""}`;

      const safeViewLink =
        ticketViewUrl && !/localhost|127\.0\.0\.1/i.test(ticketViewUrl)
          ? ticketViewUrl
          : `${String(FRONTEND_PUBLIC_BASE).replace(/\/$/, "")}/bookings/${booking._id}${tokenToAttach ? `?token=${tokenToAttach}` : ""}`;

      let html;
      try {
        html = renderTemplate("ticket", {
          name: booking.user?.name || "Guest User",
          movieName,
          theaterName: booking.showtime?.screen?.name || "Unknown Theater",
          showDate: booking.showtime?.date ? new Date(booking.showtime.date).toLocaleDateString() : "N/A",
          showTime: booking.showtime?.time || "N/A",
          seatNumber: booking.seatNumber || "N/A",
          pdfLink: safePdfLink,
          viewLink: safeViewLink,
        });
      } catch (err) {
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
    res.setHeader("Content-Disposition", `attachment; filename="ticket-${booking._id}.pdf"`);

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
        // if response already started, just destroy socket; otherwise send 500
        try {
          if (!res.headersSent) res.status(500).send("Failed to stream ticket");
          else res.destroy();
        } catch (e) {}
      });
    } else {
      throw new Error("No PDF output from generator");
    }
  } catch (err) {
    console.error("❌ Ticket download error:", err);
    // Hide internal errors from clients
    if (!res.headersSent) return res.status(500).send("Failed to generate ticket PDF");
    try { res.destroy(); } catch (e) {}
  }
});

export default router;
