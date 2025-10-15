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
 */
export async function generateTicketPdf(booking, user = {}, show = {}, opts = {}) {
  if (!booking || !booking._id) throw new Error("Invalid booking passed to generateTicketPdf");

  const {
    outDir = null,
    filename = `ticket-${String(booking._id)}.pdf`,
    baseUrl = process.env.VITE_APP_BASE_URL || process.env.APP_BASE_URL || "http://localhost:5173",
    pageSize = "A4",
  } = opts;

  const writeToFile = !!outDir;
  const tmpDir = writeToFile ? path.resolve(outDir) : os.tmpdir();

  if (writeToFile && !fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const filepath = writeToFile ? path.join(tmpDir, filename) : path.join(tmpDir, `ticket-${String(booking._id)}-${Date.now()}.pdf`);
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
    const showtimeVal = show?.startTime || show?.time || booking.showtime || booking.startTime || booking.createdAt;
    const showtimeText = showtimeVal ? new Date(showtimeVal).toLocaleString() : "—";
    const seatsText = Array.isArray(booking.seats) ? booking.seats.map((s) => `${s.row}-${s.col}`).join(", ") : (booking.seats || "N/A");
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
    const verifyUrl = `${String(baseUrl).replace(/\/$/, "")}/tickets/verify/${booking._id}`;
    let qrBuffer = null;
    try {
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: "H", margin: 1, width: 400 });
      const base64 = qrDataUrl.split(",")[1];
      qrBuffer = Buffer.from(base64, "base64");
    } catch (qrErr) {
      // QR failed: we'll render a fallback text
      console.warn("generateTicketPdf: QR generation failed:", qrErr);
      qrBuffer = null;
    }

    // Embed QR (if available)
    doc.moveDown(0.5);
    if (qrBuffer) {
      try {
        doc.image(qrBuffer, { fit: [170, 170], align: "center", valign: "center" });
      } catch (imgErr) {
        console.warn("generateTicketPdf: PDFKit failed to embed QR image:", imgErr);
        doc.fontSize(10).fillColor("#cc0000").text("QR unavailable", { align: "center" });
      }
    } else {
      doc.fontSize(10).fillColor("#cc0000").text("QR unavailable", { align: "center" });
    }

    doc.moveDown(0.6);
    doc.fontSize(9).fillColor("#666").text("Scan this QR code at the cinema gate for verification.", { align: "center" });
    doc.moveDown(0.8);
    doc.fontSize(8).fillColor("#444").text(`Verify ticket: ${verifyUrl}`, { align: "center" });

    doc.moveDown(1.2);
    doc.fontSize(9).fillColor("#777").text("Please bring this ticket to the cinema. Enjoy the show!", { align: "center" });

    doc.end();
  } catch (err) {
    try { doc.end(); } catch (e) {}
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
