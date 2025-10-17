import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = express.Router();

// Quick check
router.get("/ping", (req, res) => res.json({ ok: true, where: "upload.routes.js" }));

// Ensure uploads folder
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer setup
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
const fileFilter = (_, file, cb) => {
  if (!ALLOWED.has(file.mimetype)) return cb(new Error("Only JPG/PNG/WEBP/GIF allowed"));
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});

// POST /api/upload
router.post("/", (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE")
        return res.status(413).json({ error: "Max file size is 3MB" });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    return res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

export default router;
