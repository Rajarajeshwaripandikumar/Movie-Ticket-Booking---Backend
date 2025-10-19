// backend/src/routes/upload.routes.js
import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/* ----------------------------------------------------------------------------
 * 📁 Directory & Base URL Config
 * -------------------------------------------------------------------------- */

// Where uploads are stored locally
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Set your backend URL here (used for absolute URLs)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

/* ----------------------------------------------------------------------------
 * ⚙️ Upload Settings
 * -------------------------------------------------------------------------- */

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB

// Multer storage engine
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = path
      .basename(file.originalname || "image", ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "");
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP, or GIF files allowed"));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

/* ----------------------------------------------------------------------------
 * 🌐 Helpers
 * -------------------------------------------------------------------------- */

function toPublicUrl(filename) {
  const rel = `/uploads/${filename}`;
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${rel}` : rel;
}

/* ----------------------------------------------------------------------------
 * 🩵 Routes
 * -------------------------------------------------------------------------- */

/**
 * GET /api/upload/ping
 * Health check
 */
router.get("/ping", (_req, res) => {
  res.json({ ok: true, where: "upload.routes.js", timestamp: new Date().toISOString() });
});

/**
 * POST /api/upload
 * Single file upload
 * Field name: "image"
 */
router.post("/", requireAuth, requireAdmin, (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB" });
      }
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name: image)" });
    }

    const payload = {
      url: toPublicUrl(req.file.filename),
      relative: `/uploads/${req.file.filename}`,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    };

    console.log("[upload] saved:", req.file.filename);
    return res.status(201).json(payload);
  });
});

/**
 * POST /api/upload/multiple
 * Multiple file upload
 * Field name: "images" (array)
 */
router.post("/multiple", requireAuth, requireAdmin, (req, res) => {
  upload.array("images", 6)(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB per file" });
      }
      return res.status(400).json({ error: err.message || "Upload failed" });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No files uploaded (field name: images[])" });
    }

    const data = files.map((f) => ({
      url: toPublicUrl(f.filename),
      relative: `/uploads/${f.filename}`,
      filename: f.filename,
      size: f.size,
      mimetype: f.mimetype,
    }));

    console.log(`[upload] uploaded ${files.length} file(s)`);
    return res.status(201).json({ ok: true, files: data, count: data.length });
  });
});

/**
 * DELETE /api/upload/:filename
 * Delete an uploaded file (admin-only)
 */
router.delete("/:filename", requireAuth, requireAdmin, (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename || typeof filename !== "string") {
      return res.status(400).json({ error: "Filename required" });
    }

    const absPath = path.join(UPLOAD_DIR, filename);
    if (!absPath.startsWith(UPLOAD_DIR)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: "File not found" });
    }

    fs.unlinkSync(absPath);
    console.log("[upload] deleted:", filename);
    return res.json({ ok: true, message: "File deleted", filename });
  } catch (err) {
    console.error("[upload] delete error:", err);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});

/* ----------------------------------------------------------------------------
 * ❗ Multer Error Handling
 * -------------------------------------------------------------------------- */
router.use((err, _req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Max file size is 3MB" });
  }
  if (err && err.name === "MulterError") {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

export default router;
