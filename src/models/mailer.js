// backend/src/models/mailer.js
import dotenv from "dotenv";
dotenv.config();

import { google } from "googleapis";
import nodemailer from "nodemailer";

/* ------------------- Helpers ------------------- */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeSubject(subject) {
  if (!subject) return "";
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/* ------------------- Seat formatting helpers ------------------- */
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

function formatSeat(s) {
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

  if (s && typeof s === "object") {
    if (s.label && typeof s.label === "string") return formatSeat(s.label);
    if (s.seat && typeof s.seat === "string") return formatSeat(s.seat);
    if (s.name && typeof s.name === "string") return formatSeat(s.name);

    const rowVal = s.row ?? s.r ?? s.rowNumber ?? s.row_idx ?? null;
    const colVal = s.col ?? s.c ?? s.colNumber ?? s.column ?? s.seatNumber ?? null;

    if (typeof rowVal === "string" && /^[A-Za-z]+$/.test(rowVal.trim())) {
      const rowLetter = rowVal.trim().toUpperCase();
      if (colVal != null) {
        return `${rowLetter}-${colVal}`;
      }
      return rowLetter;
    }

    if (typeof rowVal === "number") {
      const rowLetters = numberToLetters(rowVal);
      if (rowLetters) {
        if (colVal != null) return `${rowLetters}-${colVal}`;
        return rowLetters;
      }
    }

    try {
      const keys = Object.keys(s || {});
      if (keys.length === 1) {
        const onlyKey = keys[0];
        const value = s[onlyKey];
        if (/^[A-Za-z]+$/.test(onlyKey) && (typeof value === "number" || /^[0-9]+$/.test(String(value)))) {
          return `${onlyKey.toUpperCase()}-${value}`;
        }
      }
    } catch (e) {
      // ignore
    }

    try {
      return JSON.stringify(s);
    } catch (e) {
      return String(s);
    }
  }

  return String(s);
}

function formatSeats(seats) {
  if (!seats) return "N/A";

  if (typeof seats === "string") {
    return seats
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => formatSeat(t))
      .join(", ");
  }

  if (Array.isArray(seats)) {
    try {
      const normalized = seats.map((s) => formatSeat(s));
      return normalized.join(", ");
    } catch (e) {
      return String(seats);
    }
  }

  if (typeof seats === "object") {
    if (seats.seats) return formatSeats(seats.seats);
    try {
      return JSON.stringify(seats);
    } catch (e) {
      return String(seats);
    }
  }

  return String(seats);
}

/* ------------------- Build RFC822 Gmail message ------------------- */
function makeRawMessage({ from, to, subject, html, text, cc, bcc, replyTo }) {
  const boundary = "----=_Part_" + Date.now();
  const safeText = text || (html ? html.replace(/<[^>]*>/g, "") : "");
  const encodedSubject = encodeSubject(subject);

  let lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  if (encodedSubject) lines.push(`Subject: ${encodedSubject}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push("");
  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(safeText);
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(html || safeText);
  lines.push(`--${boundary}--`);
  const message = lines.join("\r\n");
  return base64UrlEncode(message);
}

/* ------------------- Gmail API (OAuth2 HTTPS) ------------------- */
async function sendViaGmailApi({ from, to, subject, html, text, cc, bcc, replyTo }) {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER } = process.env;

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_USER) {
    return { ok: false, error: "Gmail OAuth2 credentials missing" };
  }

  try {
    const oAuth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );
    oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

    const accessTokenRes = await oAuth2Client.getAccessToken();
    const accessToken = accessTokenRes?.token || accessTokenRes;
    if (!accessToken) throw new Error("Failed to obtain Gmail access token");

    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    const raw = makeRawMessage({ from, to, subject, html, text, cc, bcc, replyTo });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    console.log(`[Mail] ✅ Gmail API sent to=${to} subject="${subject}" id=${res.data?.id}`);
    return { ok: true, provider: "gmail", messageId: res.data?.id };
  } catch (err) {
    console.error("[Mail][GmailAPI] ❌ error:", err.message);
    if (err.response?.data) console.error("Details:", err.response.data);
    return { ok: false, error: err.message };
  }
}

/* ------------------- SMTP (App Password fallback) ------------------- */
async function sendViaSmtp({ from, to, subject, html, text, cc, bcc, replyTo }) {
  try {
    const { GMAIL_USER, GMAIL_PASS } = process.env;
    if (!GMAIL_USER || !GMAIL_PASS) {
      throw new Error("GMAIL_USER or GMAIL_PASS missing for SMTP");
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      tls: { minVersion: "TLSv1.2" },
    });

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text,
      cc,
      bcc,
      replyTo,
    });

    console.log(`[Mail] ✅ SMTP sent to=${to} subject="${subject}" id=${info.messageId}`);
    return { ok: true, provider: "smtp", messageId: info.messageId };
  } catch (err) {
    console.error("[Mail][SMTP] ❌ error:", err.message);
    return { ok: false, error: err.message };
  }
}

/* ------------------- Unified sendEmail ------------------- */
export async function sendEmail({ to, subject, html, text, cc, bcc, replyTo, attachments } = {}) {
  if (!to) return { ok: false, error: "'to' required" };
  if (!subject) return { ok: false, error: "'subject' required" };
  if (!html && !text) return { ok: false, error: "'html' or 'text' required" };

  const from =
    process.env.MAIL_FROM ||
    (process.env.GMAIL_USER ? `MovieBook <${process.env.GMAIL_USER}>` : "MovieBook <no-reply@moviebook.com>");

  const payload = { from, to, subject, html, text, cc, bcc, replyTo, attachments };

  // 1️⃣ Try Gmail API (preferred)
  const gmailResult = await sendViaGmailApi(payload);
  if (gmailResult.ok) return gmailResult;

  // 2️⃣ Fallback to SMTP (attach attachments here via nodemailer if used)
  // Note: our sendViaSmtp implementation currently ignores attachments param — include attachments support below if needed
  const smtpResult = await (async () => {
    try {
      const { GMAIL_USER, GMAIL_PASS } = process.env;
      if (!GMAIL_USER || !GMAIL_PASS) {
        throw new Error("GMAIL_USER or GMAIL_PASS missing for SMTP");
      }
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
        tls: { minVersion: "TLSv1.2" },
      });

      const info = await transporter.sendMail({
        from,
        to,
        subject,
        html,
        text,
        cc,
        bcc,
        replyTo,
        attachments, // pass attachments through to nodemailer
      });

      console.log(`[Mail] ✅ SMTP sent to=${to} subject="${subject}" id=${info.messageId}`);
      return { ok: true, provider: "smtp", messageId: info.messageId };
    } catch (err) {
      console.error("[Mail][SMTP] ❌ error:", err.message);
      return { ok: false, error: err.message };
    }
  })();

  if (smtpResult.ok) return smtpResult;

  return { ok: false, error: `All mail methods failed: ${gmailResult.error}, ${smtpResult.error}` };
}

/* ------------------- URL builder helpers ------------------- */
/**
 * createTicketUrls
 * Uses your production backend/frontend URLs by default so emails never point to localhost:10000.
 * You can still override by setting BACKEND_PUBLIC_BASE and/or APP_PUBLIC_BASE env vars.
 */
export function createTicketUrls({ bookingId, token } = {}) {
  // Your production URLs (used as defaults)
  const PROD_BACKEND = "https://movie-ticket-booking-backend-o1m2.onrender.com";
  const PROD_APP = "https://movieticketbooking-rajy.netlify.app";

  // allow overrides via env
  const backendBaseEnv = (process.env.BACKEND_PUBLIC_BASE || process.env.BACKEND_URL || "").trim();
  const appBaseEnv = (process.env.APP_PUBLIC_BASE || process.env.FRONTEND_PUBLIC_BASE || "").trim();

  // local dev fallback for frontend only (still prefer env or prod values)
  const localFrontend = `http://localhost:5173`;

  const backendBase = backendBaseEnv || PROD_BACKEND;
  const appBase = appBaseEnv || (process.env.NODE_ENV === "production" ? PROD_APP : localFrontend);

  if (!bookingId) {
    return { ticketPdfUrl: "#", ticketViewUrl: "#" };
  }

  const join = (base, path) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

  const pdfPath = `api/bookings/${bookingId}/pdf${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const viewPath = `bookings/${bookingId}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

  let ticketPdfUrl = join(backendBase, pdfPath);
  let ticketViewUrl = join(appBase, viewPath);

  // safety: if env overrides exist, rewrite any localhost occurrences to them
  if (backendBaseEnv) {
    ticketPdfUrl = ticketPdfUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/gi, backendBaseEnv);
  }
  if (appBaseEnv) {
    ticketViewUrl = ticketViewUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/gi, appBaseEnv);
  }

  console.log("[Mailer] createTicketUrls ->", { bookingId, ticketPdfUrl, ticketViewUrl });
  return { ticketPdfUrl, ticketViewUrl };
}

/* ------------------- Templates ------------------- */
export const bookingConfirmedTemplate = ({
  name = "Guest",
  movieTitle = "Unknown Movie",
  showtime = "N/A",
  seats = "N/A",
  bookingId = "0000",
  ticketPdfUrl = "#",
  ticketViewUrl = "#",
} = {}) => {
  const seatsText = formatSeats(seats);

  if ((ticketPdfUrl === "#" || !ticketPdfUrl) && bookingId) {
    const { ticketPdfUrl: builtPdf, ticketViewUrl: builtView } = createTicketUrls({ bookingId });
    ticketPdfUrl = builtPdf;
    ticketViewUrl = ticketViewUrl === "#" || !ticketViewUrl ? builtView : ticketViewUrl;
  }

  return `
  <div style="font-family:sans-serif;background:#f9fafb;padding:20px;">
    <div style="max-width:600px;margin:auto;background:#fff;padding:25px;border-radius:10px;">
      <h2 style="color:#2563eb;">🎟️ Booking Confirmed</h2>
      <p>Hello <b>${name}</b>,</p>
      <p>Your booking for <b>${movieTitle}</b> on ${showtime} has been confirmed!</p>
      <p><b>Seats:</b> ${seatsText}</p>
      <p><b>Booking ID:</b> ${bookingId}</p>
      <p><a href="${ticketPdfUrl}" style="background:#2563eb;color:#fff;padding:10px 15px;text-decoration:none;border-radius:6px;">Download Ticket</a></p>
      <p>You can also view your booking here:<br><a href="${ticketViewUrl}">${ticketViewUrl}</a></p>
      <hr style="margin:25px 0;">
      <p style="font-size:13px;color:#555;">Thank you for booking with Cineme by Site!</p>
    </div>
  </div>`;
};

export const bookingCancelledTemplate = ({
  name = "Guest",
  movieTitle = "Unknown Movie",
  bookingId = "0000",
  ticketViewUrl = "#",
} = {}) => {
  if ((ticketViewUrl === "#" || !ticketViewUrl) && bookingId) {
    const { ticketViewUrl: builtView } = createTicketUrls({ bookingId });
    ticketViewUrl = builtView;
  }

  return `
  <div style="font-family:sans-serif;background:#f9fafb;padding:20px;">
    <div style="max-width:600px;margin:auto;background:#fff;padding:25px;border-radius:10px;">
      <h2 style="color:#dc2626;">❌ Booking Cancelled</h2>
      <p>Hello <b>${name}</b>,</p>
      <p>Your booking for <b>${movieTitle}</b> (ID: ${bookingId}) has been cancelled.</p>
      <p>You can rebook anytime:<br><a href="${ticketViewUrl}" style="color:#2563eb;">Rebook Now</a></p>
      <hr style="margin:25px 0;">
      <p style="font-size:13px;color:#555;">We hope to see you again soon 💙 — The Cineme by Site Team</p>
    </div>
  </div>`;
};

const TEMPLATES = {
  "booking-confirmed": bookingConfirmedTemplate,
  bookingConfirmed: bookingConfirmedTemplate,
  "booking-cancelled": bookingCancelledTemplate,
  bookingCancelled: bookingCancelledTemplate,
};

export function renderTemplate(name, data = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`renderTemplate: unknown template "${name}"`);
  return tpl(data);
}

export default {
  sendEmail,
  renderTemplate,
  bookingConfirmedTemplate,
  bookingCancelledTemplate,
  createTicketUrls,
};
