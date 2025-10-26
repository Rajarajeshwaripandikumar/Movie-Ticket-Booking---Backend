// backend/src/routes/upload.routes.js
import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/* ----------------------------------------------------------------------------
 * Cloudinary config (env vars must be set)
 * ---------------------------------------------------------------------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* ----------------------------------------------------------------------------
 * Local temp storage via multer (upload -> cloudinary -> delete local file)
 * ---------------------------------------------------------------------------- */
const TEMP_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// allow override via env e.g. MAX_UPLOAD_BYTES=8388608 (8MB)
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_BYTES || DEFAULT_MAX_BYTES);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
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
    return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only JPG, PNG, WEBP or GIF allowed"));
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
 * ---------------------------------------------------------------------------- */
function safeUnlink(fp) {
  try {
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (e) {
    console.warn("[upload] safeUnlink error:", e?.message || e);
  }
}

function extractPublicId(urlOrId) {
  if (!urlOrId) return null;
  try {
    const s = String(urlOrId).trim();
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const p = u.pathname || "";
      const idx = p.indexOf("/upload/");
      if (idx >= 0) {
        let after = p.slice(idx + "/upload/".length);
        after = after.replace(/^v\d+\//, "");
        after = after.replace(/\.[a-z0-9]+$/i, "");
        return after;
      }
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------------- */

// Health
router.get("/ping", (_req, res) =>
  res.json({ ok: true, where: "upload.routes.js", timestamp: new Date().toISOString() })
);

// Single upload (field: image)
// Protected by requireAuth + requireAdmin — remove if you want public upload
router.post("/", requireAuth, requireAdmin, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: "Max file size is " + MAX_FILE_SIZE_BYTES + " bytes" });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: err.message || "Upload failed" });
      }
      return res.status(400).json({ ok: false, error: err?.message || "Upload failed" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field: image)" });
    }

    const localPath = req.file.path;
    try {
      const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
      const result = await cloudinary.uploader.upload(localPath, {
        folder,
        use_filename: true,
        unique_filename: true,
        resource_type: "image",
      });

      safeUnlink(localPath);

      const payload = {
        ok: true,
        url: result.secure_url,
        public_id: result.public_id,
        size: req.file.size,
        mimetype: req.file.mimetype,
      };
      console.log("[upload] cloudinary saved:", payload.public_id);
      return res.status(201).json(payload);
    } catch (cloudErr) {
      console.error("[upload] cloudinary error:", cloudErr);
      safeUnlink(localPath);
      return res.status(500).json({ ok: false, error: "Cloud upload failed", details: cloudErr?.message });
    }
  });
});

// Multiple upload (field: images[])
router.post("/multiple", requireAuth, requireAdmin, (req, res) => {
  upload.array("images", 6)(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: "Max file size is " + MAX_FILE_SIZE_BYTES + " bytes per file" });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: err.message || "Upload failed" });
      }
      return res.status(400).json({ ok: false, error: err?.message || "Upload failed" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "No files uploaded (field: images[])" });

    const folder = process.env.CLOUDINARY_FOLDER || "movie-posters";
    const out = [];

    for (const f of files) {
      try {
        const r = await cloudinary.uploader.upload(f.path, {
          folder,
          use_filename: true,
          unique_filename: true,
          resource_type: "image",
        });
        out.push({ url: r.secure_url, public_id: r.public_id, size: f.size, mimetype: f.mimetype });
      } catch (e) {
        console.error("[upload/multiple] cloud upload failed for", f.path, e?.message || e);
      } finally {
        safeUnlink(f.path);
      }
    }

    return res.status(201).json({ ok: true, files: out, count: out.length });
  });
});

/**
 * DELETE /api/upload/:id
 */
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const publicId = extractPublicId(id);
    if (!publicId) return res.status(400).json({ ok: false, error: "Invalid id/url" });

    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    if (result.result === "not found") {
      return res.status(404).json({ ok: false, message: "Image not found", result });
    }
    return res.json({ ok: true, message: "Deleted", result });
  } catch (e) {
    console.error("[upload] delete error:", e);
    return res.status(500).json({ ok: false, error: "Failed to delete image", details: e?.message });
  }
});

/* Multer-specific error handler */
router.use((err, _req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "Max file size is " + MAX_FILE_SIZE_BYTES + " bytes" });
  }
  if (err && err.name === "MulterError") {
    return res.status(400).json({ ok: false, error: err.message });
  }
  return next(err);
});

export default router;
