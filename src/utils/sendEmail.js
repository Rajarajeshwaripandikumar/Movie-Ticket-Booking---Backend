// src/utils/mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_TIMEOUT = Number(process.env.EMAIL_CONNECTION_TIMEOUT || 30000); // ms

function parsePort(p) {
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function sendEmail({ to, subject, html, text }) {
  const provider = process.env.EMAIL_PROVIDER || "gmail";
  let transporter;

  try {
    if (provider === "gmail") {
      // Recommended: use an APP PASSWORD if the account has 2FA
      transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_PASS, // app password if 2FA enabled
        },
        pool: true,
        connectionTimeout: DEFAULT_TIMEOUT,
        greetingTimeout: DEFAULT_TIMEOUT,
        socketTimeout: DEFAULT_TIMEOUT,
        logger: true,
        debug: true,
      });
    } else {
      // Generic SMTP fallback
      const port = parsePort(process.env.SMTP_PORT) ?? 465;
      const secure = port === 465; // default assumption
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        pool: true,
        connectionTimeout: DEFAULT_TIMEOUT,
        greetingTimeout: DEFAULT_TIMEOUT,
        socketTimeout: DEFAULT_TIMEOUT,
        logger: true,
        debug: true,
        // If you are in a network that rewrites certs, set this to true temporarily:
        // tls: { rejectUnauthorized: process.env.EMAIL_REJECT_INVALID_TLS !== "false" }
      });
    }

    // verify the connection (will throw on timeout / auth errors)
    await transporter.verify();

    const mailOptions = {
      from:
        process.env.MAIL_FROM ||
        `"MovieBook" <${process.env.GMAIL_USER || process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      text: text || (html ? html.replace(/<[^>]*>/g, "") : ""),
    };

    // small retry wrapper for transient timeouts
    const trySend = async (attempt = 1) => {
      try {
        const info = await transporter.sendMail(mailOptions);
        console.log("[Mail] ✅ Sent:", info.response || info.messageId);
        return true;
      } catch (err) {
        console.error(`[Mail] attempt ${attempt} failed:`, err && err.stack ? err.stack : err);
        if (
          attempt < 2 &&
          err &&
          (err.code === "ETIMEDOUT" ||
            err.code === "ECONNECTION" ||
            (err.message && err.message.toLowerCase().includes("timeout")))
        ) {
          console.log("[Mail] retrying sendMail (transient) ...");
          return trySend(attempt + 1);
        }
        return false;
      }
    };

    const result = await trySend(1);
    // close pooled connections after send so containers don't hang waiting on handles
    transporter.close();
    return result;
  } catch (err) {
    console.error("[Mail] ❌ Failed to send (verify stage):", err && err.stack ? err.stack : err);
    try {
      transporter?.close();
    } catch (e) {}
    return false;
  }
}
