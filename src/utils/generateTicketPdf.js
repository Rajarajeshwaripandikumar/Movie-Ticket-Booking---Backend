// src/utils/generateTicketPdf.js
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import os from "os";
import QRCode from "qrcode";

/**
 * generateTicketPdf(booking, user = {}, show = {}, opts = {})
 * - returns { buffer } when outDir not provided
 * - returns { filepath } when outDir provided (writes file)
 *
 * opts:
 *  - outDir
 *  - filename
 *  - baseUrl  <-- highest priority (explicitly passed in)
 *  - pageSize
 */

/**
 * resolveBaseUrl(optsBaseUrl)
 * Priority:
 * 1. optsBaseUrl (explicit)
 * 2. preferred server env names (CLIENT_BASE_URL, FRONTEND_BASE_URL)
 * 3. various common env names (Netlify, Vercel, Render, etc.)
 * 4. fallback to localhost dev URL
 */
function resolveBaseUrl(optsBaseUrl) {
  // 1) explicit option passed to function has highest priority
  if (optsBaseUrl) return String(optsBaseUrl).replace(/\/$/, "");

  // 2) server / runtime env vars we want to prefer (add platform-specific names here)
  const candidates = [
    process.env.CLIENT_BASE_URL,
    process.env.FRONTEND_BASE_URL,
    process.env.BASE_URL,
    process.env.APP_BASE_URL,
    process.env.VITE_APP_BASE_URL,
    process.env.REACT_APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.SITE_URL,
    process.env.URL, // Netlify usually exposes this as full URL
    // Vercel gives a host like "my-site.vercel.app" so add protocol
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    // Render gives an external host name without protocol
    process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : undefined,
    process.env.PRODUCTION_URL,
  ].filter(Boolean);

  if (candidates.length > 0) {
    let candidate = String(candidates[0]).trim();
    // If candidate doesn't have protocol, add https by default
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    return candidate.replace(/\/$/, "");
  }

  // 3) last-resort fallback (local dev)
  return "http://localhost:5173";
}

/**
 * Main PDF generator
 */
export async function generateTicketPdf(booking, user = {}, show = {}, opts = {}) {
  if (!booking || !booking._id) throw new Error("Invalid booking passed to generateTicketPdf");

  const {
    outDir = null,
    filename = `ticket-${String(booking._id)}.pdf`,
    baseUrl: optsBaseUrl = null,
    pageSize = "A4",
  } = opts;

  // Resolve a sane baseUrl (opts overrides envs)
  const baseUrl = resolveBaseUrl(optsBaseUrl);

  const writeToFile = !!outDir;
  const tmpDir = writeToFile ? path.resolve(outDir) : os.tmpdir();

  if (writeToFile && !fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const filepath = writeToFile
    ? path.join(tmpDir, filename)
    : path.join(tmpDir, `ticket-${String(booking._id)}-${Date.now()}.pdf`);

  const doc = new PDFDocument({ margin: 40, size: pageSize });

  // If writing to file, pipe to fs stream. Otherwise capture chunks to build a buffer.
  let fileStream = null;
  const chunks = [];
  if (writeToFile) {
    fileStream = fs.createWriteStream(filepath);
    doc.pipe(fileStream);
  } else {
    doc.on("data", (c) => chunks.push(c));
    // doc.pipe is not used for in-memory path
  }

  try {
    // Header
    doc
      .fontSize(22)
      .fillColor("#0B3B6F")
      .text("Cinema Ticket", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(12)
      .fillColor("#222")
      .text("Ticket Confirmation", { align: "center" })
      .moveDown(1);

    // Booking/show/customer details
    const movieTitle = show?.movie?.title || booking.movieTitle || "Unknown Movie";
    const screenName = show?.screen?.name || booking.screenName || "—";
    const showtimeVal =
      show?.startTime || show?.time || booking.showtime || booking.startTime || booking.createdAt;
    const showtimeText = showtimeVal ? new Date(showtimeVal).toLocaleString() : "—";

    // Seats: support both array of objects and array of strings, fallback to string
    let seatsText = "N/A";
    if (Array.isArray(booking.seats)) {
      try {
        seatsText = booking.seats
          .map((s) => {
            if (s && typeof s === "object") {
              // prefer row/col fields, then seatLabel
              if (s.row != null && s.col != null) return `${s.row}-${s.col}`;
              if (s.label) return String(s.label);
              if (s.seat) return String(s.seat);
              return JSON.stringify(s);
            }
            return String(s);
          })
          .join(", ");
      } catch (e) {
        seatsText = String(booking.seats);
      }
    } else if (booking.seats) {
      seatsText = String(booking.seats);
    }

    const amountText = booking.amount ?? booking.total ?? "N/A";

    doc.fontSize(11).fillColor("#000");
    doc.text(`Movie: ${movieTitle}`);
    doc.text(`Screen: ${screenName}`);
    doc.text(`Showtime: ${showtimeText}`);
    doc.text(`Seats: ${seatsText}`);
    doc.text(`Amount Paid: ₹${amountText}`);
    doc.moveDown(1);

    // Customer info
    doc.fontSize(10).fillColor("#333");
    const customerName = user?.name || user?.fullName || booking?.userName || "Customer";
    doc.text(`Name: ${customerName}`);
    if (user?.email) doc.text(`Email: ${user.email}`);
    if (user?.phone) doc.text(`Phone: ${user.phone}`);
    doc.moveDown(1);

    // QR code generation (verify URL)
    const bookingIdStr = String(booking._id);
    const verifyUrl = `${String(baseUrl).replace(/\/$/, "")}/tickets/verify/${bookingIdStr}`;

    let qrBuffer = null;
    try {
      // generate as data URL then convert to buffer for PDFKit
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 400,
      });
      const base64 = qrDataUrl.split(",")[1];
      qrBuffer = Buffer.from(base64, "base64");
    } catch (qrErr) {
      // QR failed: we'll render a fallback text
      // Keep warning but don't crash PDF generation
      // eslint-disable-next-line no-console
      console.warn("generateTicketPdf: QR generation failed:", qrErr);
      qrBuffer = null;
    }

    // Embed QR (if available)
    doc.moveDown(0.5);
    if (qrBuffer) {
      try {
        // center the QR by placing it in the document with fit
        doc.image(qrBuffer, { fit: [170, 170], align: "center", valign: "center" });
      } catch (imgErr) {
        // eslint-disable-next-line no-console
        console.warn("generateTicketPdf: PDFKit failed to embed QR image:", imgErr);
        doc.fontSize(10).fillColor("#cc0000").text("QR unavailable", { align: "center" });
      }
    } else {
      doc.fontSize(10).fillColor("#cc0000").text("QR unavailable", { align: "center" });
    }

    doc.moveDown(0.6);
    doc.fontSize(9).fillColor("#666").text("Scan this QR code at the cinema gate for verification.", {
      align: "center",
    });
    doc.moveDown(0.8);
    doc
      .fontSize(8)
      .fillColor("#444")
      .text(`Verify ticket: ${verifyUrl}`, { align: "center", link: verifyUrl, underline: false });

    doc.moveDown(1.2);
    doc.fontSize(9).fillColor("#777").text("Please bring this ticket to the cinema. Enjoy the show!", {
      align: "center",
    });

    // finalize pdf
    doc.end();
  } catch (err) {
    try {
      // ensure doc closed if something bad happened
      doc.end();
    } catch (e) {
      // ignore
    }
    throw err;
  }

  // Wait for output and return appropriate result
  if (writeToFile) {
    await new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
    if (!fs.existsSync(filepath)) throw new Error("generateTicketPdf: file not written");
    return { filepath };
  } else {
    // Wait until doc ends and chunks collected
    const buffer = await new Promise((resolve, reject) => {
      const onEnd = () => resolve(Buffer.concat(chunks));
      const onError = (err) => reject(err);
      doc.on("end", onEnd);
      doc.on("error", onError);
    });
    return { buffer };
  }
}
