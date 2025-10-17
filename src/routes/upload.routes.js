// backend/src/routes/upload.routes.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = express.Router();

/* ───────────────────────────── uploads directory ───────────────────────────── */
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ──────────────────────────────── multer setup ─────────────────────────────── */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const fileFilter = (_, file, cb) =>
  cb(ALLOWED.has(file.mimetype) ? null : new Error("Only JPG/PNG/WEBP/GIF allowed"));

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
});

/* ────────────────────────────────── routes ─────────────────────────────────── */

// Simple ping to confirm the router is mounted
router.get("/ping", (_req, res) => res.json({ ok: true, where: "upload" }));

// POST /api/upload  (expects FormData field "image")
// Returns a *relative* URL that your frontend can resolve via FILES_BASE.
router.post("/", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // Multer-specific errors (e.g., file too large)
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB" });
      }
      return res.status(400).json({ error: err.message || "Upload error" });
    }
    if (err) {
      // Validation errors from fileFilter, etc.
      return res.status(400).json({ error: err.message || "Invalid file" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Return a relative URL. Example: /uploads/1699999999999-photo.webp
    const url = `/uploads/${req.file.filename}`;
    return res.status(201).json({ url });
  });
});

export default router;
