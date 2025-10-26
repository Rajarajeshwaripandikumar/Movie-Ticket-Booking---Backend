// backend/src/routes/upload.routes.js
/**
 * Upload routes — multer -> Cloudinary -> remove temp -> return cloud URL
 *
 * Features:
 * - Uses disk multer temporary storage (uploads/)
 * - Validates mime & max file size (override via MAX_UPLOAD_BYTES env)
 * - Uploads to Cloudinary (folder can be set via env or passed in FormData/query/body)
 * - Returns consistent JSON { ok: true, url, public_id, folder, size, mimetype }
 * - Protected by requireAuth + requireAdmin (keep that or remove if you want public uploads)
 */

import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/* ------------------------------- Cloudinary ------------------------------ */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* ------------------------------- Multer / Temp --------------------------- */
const TEMP_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024; // 3MB
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

/* -------------------------------- Helpers -------------------------------- */
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

/* ------------------------------- Routes --------------------------------- */

// health
router.get("/ping", (_req, res) =>
  res.json({ ok: true, where: "upload.routes.js", timestamp: new Date().toISOString() })
);

/**
 * POST /api/upload
 * - Accepts single file field: "image"
 * - Optional folder: provide via FormData 'folder' or query ?folder=movies or env CLOUDINARY_FOLDER
 * - Protected by requireAuth + requireAdmin (remove the middlewares if you need public uploads)
 */
router.post("/", requireAuth, requireAdmin, (req, res) => {
  // invoke multer for single file named "image"
  upload.single("image")(req, res, async (err) => {
    // TEMP: helpful debug logs could be enabled during troubleshooting
    // console.log('[upload DEBUG] headers:', { auth: req.headers.authorization, ct: req.headers['content-type'] });
    // console.log('[upload DEBUG] body keys:', Object.keys(req.body || {}));

    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: `Max file size is ${MAX_FILE_SIZE_BYTES} bytes` });
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
    const fileSize = req.file.size;
    const mimetype = req.file.mimetype;

    try {
      // determine target Cloudinary folder
      const requestedFolder = (req.body && req.body.folder) || req.query?.folder || process.env.CLOUDINARY_FOLDER || "uploads";
      // you may sanitize/validate requestedFolder here if needed

      const result = await cloudinary.uploader.upload(localPath, {
        folder: requestedFolder,
        use_filename: true,
        unique_filename: true,
        resource_type: "image",
      });

      // remove temp file
      safeUnlink(localPath);

      const payload = {
        ok: true,
        url: result.secure_url,
        public_id: result.public_id,
        folder: requestedFolder,
        size: fileSize,
        mimetype,
        raw: result, // may be large; useful for debugging
      };

      return res.status(201).json(payload);
    } catch (cloudErr) {
      console.error("[upload] cloudinary error:", cloudErr);
      safeUnlink(localPath);
      return res.status(500).json({ ok: false, error: "Cloud upload failed", details: cloudErr?.message });
    }
  });
});

/**
 * POST /api/upload/multiple
 * - Accepts files field: "images[]" (up to 6 by default)
 */
router.post("/multiple", requireAuth, requireAdmin, (req, res) => {
  upload.array("images", 6)(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: `Max file size is ${MAX_FILE_SIZE_BYTES} bytes per file` });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: err.message || "Upload failed" });
      }
      return res.status(400).json({ ok: false, error: err?.message || "Upload failed" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "No files uploaded (field: images[])" });

    const requestedFolder = (req.body && req.body.folder) || req.query?.folder || process.env.CLOUDINARY_FOLDER || "uploads";
    const out = [];

    for (const f of files) {
      try {
        const r = await cloudinary.uploader.upload(f.path, {
          folder: requestedFolder,
          use_filename: true,
          unique_filename: true,
          resource_type: "image",
        });
        out.push({ ok: true, url: r.secure_url, public_id: r.public_id, size: f.size, mimetype: f.mimetype });
      } catch (e) {
        console.error("[upload/multiple] cloud upload failed for", f.path, e?.message || e);
      } finally {
        safeUnlink(f.path);
      }
    }

    return res.status(201).json({ ok: true, files: out, count: out.length, folder: requestedFolder });
  });
});

/**
 * DELETE /api/upload/:id
 * - Accepts Cloudinary public_id OR full Cloudinary URL
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

/* -------------------------- Multer Error Handler ------------------------- */
router.use((err, _req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: `Max file size is ${MAX_FILE_SIZE_BYTES} bytes` });
  }
  if (err && err.name === "MulterError") {
    return res.status(400).json({ ok: false, error: err.message });
  }
  return next(err);
});

export default router;
