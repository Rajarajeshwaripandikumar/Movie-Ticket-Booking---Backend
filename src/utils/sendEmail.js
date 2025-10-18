import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

export async function sendEmail({ to, subject, html, text }) {
  try {
    const provider = process.env.EMAIL_PROVIDER || "gmail";

    let transporter;

    if (provider === "gmail") {
      transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_PASS,
        },
      });
    } else {
      // fallback generic SMTP config
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    }

    const mailOptions = {
      from: process.env.MAIL_FROM || `"MovieBook" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || html?.replace(/<[^>]*>/g, ""), // fallback to plain text
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("[Mail] ✅ Sent:", info.response);
    return true;
  } catch (err) {
    console.error("[Mail] ❌ Failed to send:", err.message);
    return false;
  }
}
