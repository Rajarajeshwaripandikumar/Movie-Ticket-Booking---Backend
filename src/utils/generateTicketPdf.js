// backend/src/utils/generateTicketPdf.js
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

/* -------------------------------------------------------------------------- */
/*                          BASE URL RESOLUTION                               */
/* -------------------------------------------------------------------------- */

function resolveBaseUrl(optsBaseUrl) {
  if (optsBaseUrl) return String(optsBaseUrl).replace(/\/$/, "");

  const candidates = [
    process.env.CLIENT_BASE_URL,
    process.env.FRONTEND_BASE_URL,
    process.env.BASE_URL,
    process.env.APP_BASE_URL,
    process.env.VITE_APP_BASE_URL,
    process.env.REACT_APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.SITE_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    process.env.RENDER_EXTERNAL_URL
      ? `https://${process.env.RENDER_EXTERNAL_URL}`
      : undefined,
    process.env.PRODUCTION_URL,
  ].filter(Boolean);

  if (candidates.length > 0) {
    let candidate = String(candidates[0]).trim();
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    return candidate.replace(/\/$/, "");
  }

  return "http://localhost:5173";
}

/* -------------------------------------------------------------------------- */
/*                      SEAT LABEL HELPERS                                    */
/* -------------------------------------------------------------------------- */

function numberToLetters(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  let num = Math.floor(n);
  let letters = "";
  while (num > 0) {
    num -= 1;
    letters = String.fromCharCode(65 + (num % 26)) + letters;
    num = Math.floor(num / 26);
  }
  return letters;
}

/**
 * Convert stored seatId to human readable "ROWLETTER-COL"
 * Supports:
 *  - "1:9"    -> A-9
 *  - "7:10"   -> G-10
 *  - "R7C10"  -> G-10
 */
function seatIdToLabel(seatId) {
  if (!seatId && seatId !== 0) return "";
  const s = String(seatId).trim();

  let m = s.match(/^(\d+):(\d+)$/);
  if (m) {
    const rowNum = parseInt(m[1], 10);
    const colNum = parseInt(m[2], 10);
    const rowLetters = numberToLetters(rowNum) || `R${rowNum}`;
    return `${rowLetters}-${colNum}`;
  }

  m = s.match(/^R(\d+)C(\d+)$/i);
  if (m) {
    const rowNum = parseInt(m[1], 10);
    const colNum = parseInt(m[2], 10);
    const rowLetters = numberToLetters(rowNum) || `R${rowNum}`;
    return `${rowLetters}-${colNum}`;
  }

  return s;
}

/**
 * Normalize ONE seat to "ROWLETTER-COL" where possible.
 */
function formatSeat(s) {
  // string
  if (typeof s === "string") {
    const trimmed = s.trim();

    const hyphenMatch = trimmed.match(/^([A-Za-z]+)\s*-\s*(\d+)$/);
    if (hyphenMatch) {
      return `${hyphenMatch[1].toUpperCase()}-${hyphenMatch[2]}`;
    }

    const letterNumberMatch = trimmed.match(/^([A-Za-z]+)\s*?(\d+)$/);
    if (letterNumberMatch) {
      return `${letterNumberMatch[1].toUpperCase()}-${letterNumberMatch[2]}`;
    }

    return trimmed;
  }

  // object
  if (s && typeof s === "object") {
    // ⭐ important: handle { seatId: "1:9" }
    if (s.seatId) {
      return seatIdToLabel(s.seatId);
    }

    if (s.label && typeof s.label === "string") return formatSeat(s.label);
    if (s.seat && typeof s.seat === "string") return formatSeat(s.seat);
    if (s.name && typeof s.name === "string") return formatSeat(s.name);

    const rowVal = s.row ?? s.r ?? s.rowNumber ?? s.row_idx ?? null;
    const colVal =
      s.col ?? s.c ?? s.colNumber ?? s.column ?? s.seatNumber ?? null;

    if (typeof rowVal === "string" && /^[A-Za-z]+$/.test(rowVal.trim())) {
      const rowLetter = rowVal.trim().toUpperCase();
      if (colVal != null) return `${rowLetter}-${colVal}`;
      return rowLetter;
    }

    if (typeof rowVal === "number") {
      const rowLetters = numberToLetters(rowVal);
      if (rowLetters) {
        if (colVal != null) return `${rowLetters}-${colVal}`;
        return rowLetters;
      }
    }

    // special fallback: { H: 6 }
    try {
      const keys = Object.keys(s || {});
      if (keys.length === 1) {
        const onlyKey = keys[0];
        const value = s[onlyKey];
        if (
          /^[A-Za-z]+$/.test(onlyKey) &&
          (typeof value === "number" || /^[0-9]+$/.test(String(value)))
        ) {
          return `${onlyKey.toUpperCase()}-${value}`;
        }
      }
    } catch {
      // ignore
    }

    try {
      return JSON.stringify(s);
    } catch {
      return String(s);
    }
  }

  // primitive fallback
  return String(s);
}

/**
 * Turn booking.seats (whatever shape) into a display string: "A-9, A-10"
 * Handles:
 *  - array of seats
 *  - single object
 *  - JSON string
 *  - plain strings
 */
function formatSeatsField(rawSeats) {
  if (rawSeats == null) return "N/A";

  let seats = rawSeats;

  // If it's a JSON string like '{"seatId":"1:9"}' or '[{...}]'
  if (typeof seats === "string") {
    const trimmed = seats.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        seats = JSON.parse(trimmed);
      } catch {
        // leave as plain string
      }
    }
  }

  // Now normalise to an array if possible
  if (Array.isArray(seats)) {
    const labels = seats.map((s) => formatSeat(s)).filter(Boolean);
    return labels.length ? labels.join(", ") : "N/A";
  }

  if (seats && typeof seats === "object") {
    // single object like { seatId: "1:9" }
    const label = formatSeat(seats);
    return label || "N/A";
  }

  if (typeof seats === "string") {
    return seats;
  }

  return String(seats);
}

/* -------------------------------------------------------------------------- */
/*                           MAIN PDF FUNCTION                                */
/* -------------------------------------------------------------------------- */

export async function generateTicketPdf(
  booking,
  user = {},
  show = {},
  opts = {}
) {
  if (!booking || !booking._id) {
    throw new Error("Invalid booking passed to generateTicketPdf");
  }

  const {
    outDir = null,
    filename = `ticket-${String(booking._id)}.pdf`,
    baseUrl: optsBaseUrl = null,
    pageSize = "A4",
  } = opts;

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

  let fileStream = null;
  const chunks = [];
  if (writeToFile) {
    fileStream = fs.createWriteStream(filepath);
    doc.pipe(fileStream);
  } else {
    doc.on("data", (c) => chunks.push(c));
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
    const movieTitle =
      show?.movie?.title || booking.movieTitle || "Unknown Movie";
    const screenName = show?.screen?.name || booking.screenName || "—";
    const showtimeVal =
      show?.startTime ||
      show?.time ||
      booking.showtime ||
      booking.startTime ||
      booking.createdAt;
    const showtimeText = showtimeVal
      ? new Date(showtimeVal).toLocaleString()
      : "—";

    // ⭐ Seats (robust)
    const seatsText = formatSeatsField(booking.seats);

    // ⭐ Amount (take totalAmount first)
    const rawAmount =
      booking.totalAmount ??
      booking.amount ??
      booking.paymentAmount ??
      booking.payment?.amount ??
      booking.total ??
      null;

    const amountText =
      rawAmount == null || Number.isNaN(Number(rawAmount))
        ? "N/A"
        : Number(rawAmount).toFixed(2);

    doc.fontSize(11).fillColor("#000");
    doc.text(`Movie: ${movieTitle}`);
    doc.text(`Screen: ${screenName}`);
    doc.text(`Showtime: ${showtimeText}`);
    doc.text(`Seats: ${seatsText}`);
    doc.text(`Amount Paid: ₹${amountText}`);
    doc.moveDown(1);

    // Customer info
    doc.fontSize(10).fillColor("#333");
    const customerName =
      user?.name || user?.fullName || booking?.userName || "Customer";
    doc.text(`Name: ${customerName}`);
    if (user?.email) doc.text(`Email: ${user.email}`);
    if (user?.phone) doc.text(`Phone: ${user.phone}`);
    doc.moveDown(1);

    // QR code generation
    const bookingIdStr = String(booking._id);
    const verifyUrl = `${String(baseUrl).replace(
      /\/$/,
      ""
    )}/tickets/verify/${bookingIdStr}`;

    let qrBuffer = null;
    try {
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 400,
      });
      const base64 = qrDataUrl.split(",")[1];
      qrBuffer = Buffer.from(base64, "base64");
    } catch (qrErr) {
      console.warn("generateTicketPdf: QR generation failed:", qrErr);
      qrBuffer = null;
    }

    doc.moveDown(0.5);
    if (qrBuffer) {
      try {
        doc.image(qrBuffer, {
          fit: [170, 170],
          align: "center",
          valign: "center",
        });
      } catch (imgErr) {
        console.warn("generateTicketPdf: embed QR failed:", imgErr);
        doc
          .fontSize(10)
          .fillColor("#cc0000")
          .text("QR unavailable", { align: "center" });
      }
    } else {
      doc
        .fontSize(10)
        .fillColor("#cc0000")
        .text("QR unavailable", { align: "center" });
    }

    doc.moveDown(0.6);
    doc
      .fontSize(9)
      .fillColor("#666")
      .text("Scan this QR code at the cinema gate for verification.", {
        align: "center",
      });
    doc.moveDown(0.8);
    doc
      .fontSize(8)
      .fillColor("#444")
      .text(`Verify ticket: ${verifyUrl}`, {
        align: "center",
        link: verifyUrl,
        underline: false,
      });

    doc.moveDown(1.2);
    doc
      .fontSize(9)
      .fillColor("#777")
      .text("Please bring this ticket to the cinema. Enjoy the show!", {
        align: "center",
      });

    doc.end();
  } catch (err) {
    try {
      doc.end();
    } catch {
      // ignore
    }
    throw err;
  }

  if (writeToFile) {
    await new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
    if (!fs.existsSync(filepath)) {
      throw new Error("generateTicketPdf: file not written");
    }
    return { filepath };
  } else {
    const buffer = await new Promise((resolve, reject) => {
      const onEnd = () => resolve(Buffer.concat(chunks));
      const onError = (err) => reject(err);
      doc.on("end", onEnd);
      doc.on("error", onError);
    });
    return { buffer };
  }
}
