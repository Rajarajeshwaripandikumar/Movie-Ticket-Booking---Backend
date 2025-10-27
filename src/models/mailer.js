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

/* Build RFC822 Gmail message */
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
export async function sendEmail({ to, subject, html, text, cc, bcc, replyTo }) {
  if (!to) return { ok: false, error: "'to' required" };
  if (!subject) return { ok: false, error: "'subject' required" };
  if (!html && !text) return { ok: false, error: "'html' or 'text' required" };

  const from =
    process.env.MAIL_FROM ||
    (process.env.GMAIL_USER ? `MovieBook <${process.env.GMAIL_USER}>` : "MovieBook <no-reply@moviebook.com>");

  const payload = { from, to, subject, html, text, cc, bcc, replyTo };

  // 1️⃣ Try Gmail API (preferred on Render)
  const gmailResult = await sendViaGmailApi(payload);
  if (gmailResult.ok) return gmailResult;

  // 2️⃣ Fallback to SMTP if Gmail API fails
  const smtpResult = await sendViaSmtp(payload);
  if (smtpResult.ok) return smtpResult;

  return { ok: false, error: `All mail methods failed: ${gmailResult.error}, ${smtpResult.error}` };
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
  supportEmail = "support@example.com",
  supportPhone = "+91-00000-00000",
}) => `
  <div style="font-family:sans-serif;background:#f9fafb;padding:20px;">
    <div style="max-width:600px;margin:auto;background:#fff;padding:25px;border-radius:10px;">
      <h2 style="color:#2563eb;">🎟️ Booking Confirmed</h2>
      <p>Hello <b>${name}</b>,</p>
      <p>Your booking for <b>${movieTitle}</b> on ${showtime} has been confirmed!</p>
      <p><b>Seats:</b> ${seats}</p>
      <p><b>Booking ID:</b> ${bookingId}</p>
      <p><a href="${ticketPdfUrl}" style="background:#2563eb;color:#fff;padding:10px 15px;text-decoration:none;border-radius:6px;">Download Ticket</a></p>
      <p>You can also view your booking here:<br><a href="${ticketViewUrl}">${ticketViewUrl}</a></p>
      <hr style="margin:25px 0;">
   
      <p style="font-size:13px;color:#555;">Thank you for booking with Cineme by Site!</p>
    </div>
  </div>
`;

export const bookingCancelledTemplate = ({
  name = "Guest",
  movieTitle = "Unknown Movie",
  bookingId = "0000",
  ticketViewUrl = "#",
  supportEmail = "support@example.com",
  supportPhone = "+91-00000-00000",
}) => `
  <div style="font-family:sans-serif;background:#f9fafb;padding:20px;">
    <div style="max-width:600px;margin:auto;background:#fff;padding:25px;border-radius:10px;">
      <h2 style="color:#dc2626;">❌ Booking Cancelled</h2>
      <p>Hello <b>${name}</b>,</p>
      <p>Your booking for <b>${movieTitle}</b> (ID: ${bookingId}) has been cancelled.</p>
      <p>If this was a mistake, you can rebook anytime:<br>
      <a href="${ticketViewUrl}" style="color:#2563eb;">Rebook Now</a></p>
      <hr style="margin:25px 0;">
      
      <p style="font-size:13px;color:#555;">We hope to see you again soon 💙 — The Cineme by Site Team</p>
    </div>
  </div>
`;

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

export default { sendEmail, renderTemplate, bookingConfirmedTemplate, bookingCancelledTemplate };
