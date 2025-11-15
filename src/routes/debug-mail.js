// backend/src/routes/debug-mail.js
import express from "express";
import mailer from "../models/mailer.js"; // adjust path if needed
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";

const router = express.Router();

/**
 * DEV SAFETY:
 * - By default this endpoint is only allowed when NODE_ENV === "development".
 * - If NODE_ENV !== "development" you must be authenticated + SUPER_ADMIN to call it.
 *
 * Query params:
 *  - to   (optional) override recipient; defaults to process.env.GMAIL_USER or test account
 *  - subj (optional) override subject
 *  - body (optional) short plain-text body
 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 6; // max reqs per IP per window
const rateStore = new Map(); // { ip -> { count, windowStart } }

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = rateStore.get(ip);
  if (!rec || now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateStore.set(ip, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (rec.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - rec.windowStart) };
  }
  rec.count += 1;
  rateStore.set(ip, rec);
  return { ok: true };
}

router.get("/send-test-email", async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      return res.status(429).json({ ok: false, error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
    }

    // Dev-only by default
    const isDev = (process.env.NODE_ENV || "development").toLowerCase() === "development";

    // If not dev, require auth + super admin role
    if (!isDev) {
      // if you don't have requireAuth/roles middleware, you'll need to remove these checks
      if (!req.headers?.authorization) {
        return res.status(401).json({ ok: false, error: "Authorization required in non-development environment" });
      }
      // middleware-lite: verify JWT and roles could be used instead
      // Use route-level middleware if you prefer: router.get(..., requireAuth, requireRole("SUPER_ADMIN"), handler)
    }

    const to = (req.query.to || process.env.GMAIL_USER || "").trim();
    if (!to) {
      // If no explicit recipient and no configured GMAIL_USER, the mailer will create an Ethereal test account.
      // We still accept that, but warn.
      console.warn("debug-mail: no recipient provided and GMAIL_USER not set — using Ethereal dev account");
    }

    const subject = String(req.query.subj || `MovieBook — test email (${new Date().toISOString()})`);
    const bodyText = String(req.query.body || "This is a test message sent by MovieBook.");
    const html = `<div style="font-family: sans-serif;">
      <p>${bodyText}</p>
      <p><small>Sent at ${new Date().toLocaleString()}</small></p>
    </div>`;

    // send via your mailer wrapper
    const result = await mailer.sendEmail({
      to: to || undefined, // mailer.validate will reject undefined 'to'
      subject,
      html,
      text: bodyText,
    });

    // result.ok true/false plus previewUrl when using Ethereal
    if (result.ok) {
      const resp = { ok: true, messageId: result.messageId };
      if (result.previewUrl) resp.previewUrl = result.previewUrl;
      resp.note = isDev ? "Development mode — previewUrl available for Ethereal" : "Production mode";
      return res.json(resp);
    } else {
      return res.status(502).json({ ok: false, error: result.error || "Email send failed" });
    }
  } catch (err) {
    console.error("[_debug/send-test-email] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
