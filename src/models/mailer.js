// backend/src/models/mailer.js


import nodemailer from "nodemailer";

let transporter = null;

/* -------------------------------------------------------------------------- */
/*                            Create Mail Transporter                         */
/* -------------------------------------------------------------------------- */
async function createTransporter() {
  if (transporter) return transporter;

  try {
    const { GMAIL_USER, GMAIL_PASS } = process.env;

    if (GMAIL_USER && GMAIL_PASS) {
      // ✅ Gmail via App Password
      transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
        logger: true,
        debug: true,
        tls: { minVersion: "TLSv1.2" },
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
      });
      console.log("Mailer: Using Gmail account:", GMAIL_USER);
    } else {
      // 🧪 Dev fallback: Ethereal (provides preview URL)
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass },
        logger: true,
        debug: true,
      });
      console.log("Mailer: Using Ethereal dev account");
      console.log("  Login:", testAccount.user);
      console.log("  Pass :", testAccount.pass);
    }

    await transporter.verify();
    console.log("Mailer verified ✅");
    return transporter;
  } catch (err) {
    console.error("Mailer transporter error ❌", err?.message || err);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                               Send Email Func                              */
/* -------------------------------------------------------------------------- */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments = [],
  cc,
  bcc,
  replyTo,
}) {
  if (!to) return { ok: false, error: "sendEmail: 'to' is required" };
  if (!subject) return { ok: false, error: "sendEmail: 'subject' is required" };
  if (!html && !text) return { ok: false, error: "sendEmail: 'html' or 'text' required" };

  try {
    const tr = await createTransporter();

    const from =
      process.env.MAIL_FROM ||
      (process.env.GMAIL_USER
        ? `MovieBook <${process.env.GMAIL_USER}>`
        : "MovieBook <no-reply@moviebook.local>");

    const info = await tr.sendMail({
      from,
      to,
      subject,
      html,
      text,
      attachments,
      cc,
      bcc,
      replyTo,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;

    console.log(
      `📨 Sent email | to=${to} | subject="${subject}" | id=${info.messageId}${
        previewUrl ? ` | preview=${previewUrl}` : ""
      }`
    );

    return { ok: true, messageId: info.messageId, accepted: info.accepted, previewUrl };
  } catch (e) {
    console.error("sendEmail ❌", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Templates                                */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*                             renderTemplate API                              */
/* -------------------------------------------------------------------------- */
// Accept multiple name styles for convenience
const TEMPLATES = {
  // confirmed
  "booking-confirmed": bookingConfirmedTemplate,
  bookingConfirmed: bookingConfirmedTemplate,
  booking_confirmed: bookingConfirmedTemplate,
  // cancelled
  "booking-cancelled": bookingCancelledTemplate,
  bookingCancelled: bookingCancelledTemplate,
  booking_cancelled: bookingCancelledTemplate,
};

export function renderTemplate(name, data = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) {
    throw new Error(
      `renderTemplate: unknown template "${name}". Valid: ${Object.keys(TEMPLATES).join(", ")}`
    );
  }
  return tpl(data);
}

/* -------------------------------------------------------------------------- */
/*                              Default Export                                */
/* -------------------------------------------------------------------------- */
export default {
  sendEmail,
  renderTemplate,
  bookingConfirmedTemplate,
  bookingCancelledTemplate,
};
