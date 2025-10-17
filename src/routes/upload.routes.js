// backend/src/routes/upload.routes.js
import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = Router();

/* ----------------------------------------------------------------------------
 * Config
 * --------------------------------------------------------------------------*/

// Directory to store uploads (filesystem is ephemeral on many hosts)
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Public base (set in .env for absolute URLs)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// Allowed mime-types and max size
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024; // 3MB

/* ----------------------------------------------------------------------------
 * Multer setup
 * --------------------------------------------------------------------------*/

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
    return cb(new Error("Only JPG, PNG, WEBP, or GIF are allowed"));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

/* ----------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

function toPublicUrl(filename) {
  const rel = `/uploads/${filename}`;
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${rel}` : rel;
}

/* ----------------------------------------------------------------------------
 * Routes
 * --------------------------------------------------------------------------*/

// Health/ping: GET /api/upload/ping
router.get("/ping", (_req, res) => {
  res.json({ ok: true, where: "upload.routes.js" });
});

// Single upload: POST /api/upload
// Field name must be "image"
router.post("/", (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB" });
      }
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field: image)" });
    }

    const payload = {
      url: toPublicUrl(req.file.filename),
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    };
    return res.status(201).json(payload);
  });
});

// Multi upload (optional): POST /api/upload/multiple
// Field name must be "images" (array)
router.post("/multiple", (req, res) => {
  upload.array("images", 6)(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB per file" });
      }
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded (field: images[])" });

    const data = files.map((f) => ({
      url: toPublicUrl(f.filename),
      filename: f.filename,
      size: f.size,
      mimetype: f.mimetype,
    }));
    return res.status(201).json({ files: data, count: data.length });
  });
});

/* ----------------------------------------------------------------------------
 * Multer-specific error handler (kept local to this router)
 * --------------------------------------------------------------------------*/
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
