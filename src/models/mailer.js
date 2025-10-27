// backend/src/models/mailer.js
import dotenv from "dotenv";
dotenv.config();

import { google } from "googleapis";
import nodemailer from "nodemailer"; // used only for Ethereal fallback
import fetch from "node-fetch";

/* ---------------- helpers ---------------- */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeRawMessage({ from, to, subject, html, text, cc, bcc, replyTo }) {
  const boundary = "----=_Part_" + Date.now();
  const safeText = text || (html ? html.replace(/<[^>]*>/g, "") : "");
  let lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${subject}`);
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

/* ---------------- Gmail API sender (HTTPS) ---------------- */
async function sendViaGmailApi({ from, to, subject, html, text, cc, bcc, replyTo }) {
  const {
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN,
    GMAIL_USER,
  } = process.env;

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_USER) {
    return { ok: false, error: "Gmail OAuth2 env vars missing" };
  }

  try {
    const oAuth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );
    oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

    // googleapis will refresh the token if needed
    const accessTokenRes = await oAuth2Client.getAccessToken();
    const accessToken = accessTokenRes?.token || accessTokenRes;
    if (!accessToken) {
      return { ok: false, error: "Failed to obtain Gmail access token" };
    }

    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const raw = makeRawMessage({
      from: from || `MovieBook <${GMAIL_USER}>`,
      to,
      subject,
      html,
      text,
      cc,
      bcc,
      replyTo,
    });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return { ok: true, messageId: res.data?.id, rawResponse: res.data };
  } catch (err) {
    console.error("[Mail][GmailAPI] error:", err && err.stack ? err.stack : err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ---------------- SendGrid HTTPS fallback ---------------- */
async function sendViaSendGrid({ from, to, subject, html, text }) {
  const key = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SG_FROM || from || "no-reply@moviebook.com";
  if (!key) return { ok: false, error: "SENDGRID_API_KEY not set" };

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromEmail },
    subject,
    content: [{ type: "text/html", value: html || text || "" }],
  };

  try {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error("[Mail][SendGrid] error:", r.status, txt);
      return { ok: false, status: r.status, error: txt };
    }
    return { ok: true };
  } catch (err) {
    console.error("[Mail][SendGrid] fetch error:", err && err.stack ? err.stack : err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ---------------- export sendEmail that auto-selects ---------------- */
export async function sendEmail({ to, subject, html, text, cc, bcc, replyTo }) {
  if (!to) return { ok: false, error: "'to' required" };
  if (!subject) return { ok: false, error: "'subject' required" };
  if (!html && !text) return { ok: false, error: "'html' or 'text' required" };

  const fromEnv = process.env.MAIL_FROM || (process.env.GMAIL_USER ? `MovieBook <${process.env.GMAIL_USER}>` : "MovieBook <no-reply@moviebook.com>");
  const payload = { from: fromEnv, to, subject, html, text, cc, bcc, replyTo };

  // 1) Try Gmail API (HTTPS)
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_USER) {
    const r = await sendViaGmailApi(payload);
    if (r.ok) {
      console.log("[Mail] Sent via Gmail API:", to, subject);
      return r;
    }
    console.warn("[Mail] Gmail API failed, falling back if possible:", r.error);
  }

  // 2) Try SendGrid (if configured)
  if (process.env.SENDGRID_API_KEY) {
    const r = await sendViaSendGrid(payload);
    if (r.ok) {
      console.log("[Mail] Sent via SendGrid:", to, subject);
      return r;
    }
    console.warn("[Mail] SendGrid failed:", r.error);
    return r;
  }

  // 3) Local dev fallback: Ethereal
  try {
    const acct = await nodemailer.createTestAccount();
    const transporter = nodemailer.createTransport({
      host: acct.smtp.host,
      port: acct.smtp.port,
      secure: acct.smtp.secure,
      auth: { user: acct.user, pass: acct.pass },
    });
    const info = await transporter.sendMail({
      from: fromEnv,
      to,
      subject,
      text: text || (html ? html.replace(/<[^>]*>/g, "") : ""),
      html,
    });
    const preview = nodemailer.getTestMessageUrl(info);
    console.log("[Mail][Ethereal] preview:", preview);
    return { ok: true, previewUrl: preview, messageId: info.messageId };
  } catch (err) {
    console.error("[Mail] final fallback failed:", err && err.stack ? err.stack : err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ---------------- Templates (your existing templates) ---------------- */
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
      <p>
        <a href="${ticketPdfUrl}" style="background:#2563eb;color:#fff;padding:10px 15px;text-decoration:none;border-radius:6px;">Download Ticket</a>
      </p>
      <p>You can also view your booking here:<br><a href="${ticketViewUrl}">${ticketViewUrl}</a></p>
      <hr style="margin:25px 0;">
      <p>Need help?<br>
        📧 <a href="mailto:${supportEmail}">${supportEmail}</a><br>
        ☎️ <a href="tel:${supportPhone}">${supportPhone}</a>
      </p>
      <p style="font-size:13px;color:#555;">Thank you for booking with MovieBook!</p>
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
      <p>Need help?<br>
        📧 <a href="mailto:${supportEmail}">${supportEmail}</a><br>
        ☎️ <a href="tel:${supportPhone}">${supportPhone}</a>
      </p>
      <p style="font-size:13px;color:#555;">We hope to see you again soon 💙 — The MovieBook Team</p>
    </div>
  </div>
`;

const TEMPLATES = {
  "booking-confirmed": bookingConfirmedTemplate,
  bookingConfirmed: bookingConfirmedTemplate,
  booking_confirmed: bookingConfirmedTemplate,
  "booking-cancelled": bookingCancelledTemplate,
  bookingCancelled: bookingCancelledTemplate,
  booking_cancelled: bookingCancelledTemplate,
};

export function renderTemplate(name, data = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`renderTemplate: unknown template "${name}"`);
  return tpl(data);
}

export default { sendEmail, renderTemplate, bookingConfirmedTemplate, bookingCancelledTemplate };
