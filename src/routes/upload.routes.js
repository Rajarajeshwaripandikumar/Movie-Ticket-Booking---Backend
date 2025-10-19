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
const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB

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

/**
 * extractPublicId(urlOrId)
 * Accepts either:
 *  - full cloudinary URL: https://res.cloudinary.com/<cloud>/image/upload/v12345/folder/name.jpg
 *  - or public_id (folder/name)
 * Returns public_id or null
 */
function extractPublicId(urlOrId) {
  if (!urlOrId) return null;
  try {
    const s = String(urlOrId).trim();
    // Looks like a URL
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      // path after /upload/
      const p = u.pathname;
      const idx = p.indexOf("/upload/");
      if (idx >= 0) {
        // everything after /upload/ and drop version segment like /v12345/
        let after = p.slice(idx + "/upload/".length);
        // remove leading /v{digits}/ if present
        after = after.replace(/^v\d+\//, "");
        // strip extension (.jpg .png) from end for public_id
        after = after.replace(/\.[a-z0-9]+$/i, "");
        return after;
      }
      return null;
    }
    // Not a URL, assume it's already a public_id
    return s;
  } catch (e) {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------------- */

// Health
router.get("/ping", (_req, res) => res.json({ ok: true, where: "cloudinary-upload.routes.js", timestamp: new Date().toISOString() }));

// Single upload (field: image)
router.post("/", requireAuth, requireAdmin, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB" });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.message || "Upload failed" });
      }
      return res.status(400).json({ error: err?.message || "Upload failed" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field: image)" });
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

      // remove temp file
      safeUnlink(localPath);

      // result.public_id is the Cloudinary id (folder/filename)
      // result.secure_url is the CDN url
      const payload = {
        url: result.secure_url,
        filename: result.public_id,
        size: req.file.size,
        mimetype: req.file.mimetype,
      };
      console.log("[upload] cloudinary saved:", payload.filename);
      return res.status(201).json(payload);
    } catch (cloudErr) {
      console.error("[upload] cloudinary error:", cloudErr);
      safeUnlink(localPath);
      return res.status(500).json({ error: "Cloud upload failed", details: cloudErr?.message });
    }
  });
});

// Multiple upload (field: images[])
router.post("/multiple", requireAuth, requireAdmin, (req, res) => {
  upload.array("images", 6)(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Max file size is 3MB per file" });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.message || "Upload failed" });
      }
      return res.status(400).json({ error: err?.message || "Upload failed" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded (field: images[])" });

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
        out.push({ url: r.secure_url, filename: r.public_id, size: f.size, mimetype: f.mimetype });
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
 * Accepts either:
 *  - Cloudinary public_id (folder/name)
 *  - full Cloudinary URL
 */
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const publicId = extractPublicId(id);
    if (!publicId) return res.status(400).json({ error: "Invalid id/url" });

    // destroy resource (image)
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    // result.result can be "ok" or "not found"
    if (result.result === "not found") {
      return res.status(404).json({ ok: false, message: "Image not found", result });
    }
    return res.json({ ok: true, message: "Deleted", result });
  } catch (e) {
    console.error("[upload] delete error:", e);
    return res.status(500).json({ error: "Failed to delete image", details: e?.message });
  }
});

/* Multer-specific error handler (kept local) */
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
