// backend/src/routes/debug-mail.js
import express from "express";
import mailer from "../models/mailer.js"; // <- change path if needed

const router = express.Router();

/**
 * GET  /_debug/send-test-email
 * Query params:
 *   to - optional override recipient (defaults to GMAIL_USER)
 */
router.get("/send-test-email", async (req, res) => {
  const to = req.query.to || process.env.GMAIL_USER;
  if (!to) return res.status(400).json({ ok: false, error: "no 'to' address and GMAIL_USER not set" });

  const subject = "MovieBook — test email";
  const html = `<p>This is a <b>test email</b> sent by MovieBook on ${new Date().toISOString()}</p>`;
  const text = `Test email from MovieBook (${new Date().toISOString()})`;

  try {
    const result = await mailer.sendEmail({ to, subject, html, text });
    // return the provider and any messageId or rawResponse for inspection
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("[_debug/send-test-email] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
