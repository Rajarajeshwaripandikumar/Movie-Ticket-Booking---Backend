/**
 * Safer Upload routes — memory/disk safe, Cloudinary streaming, robust uploads dir handling
 *
 * Notes:
 * - Recommended: set USE_MEMORY_UPLOAD=true in your environment to avoid disk writes (best for Render).
 * - Recommended: set UPLOADS_DIR=/tmp/uploads in production (avoid writing into your project src).
 * - Ensure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET are set for Cloud uploads.
 */

import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import streamifier from "streamifier";
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

const USE_MEMORY_UPLOAD = String(process.env.USE_MEMORY_UPLOAD || "false").toLowerCase() === "true";
const PUBLIC_UPLOADS = String(process.env.PUBLIC_UPLOADS || "false").toLowerCase() === "true";
const DEBUG_UPLOAD = String(process.env.DEBUG_UPLOAD || "false").toLowerCase() === "true";

/* ------------------------------- UPLOADS DIR ----------------------------- */
// Prefer /tmp on Render by default (project dir is read-only there)
const isRender = !!process.env.RENDER;
const DEFAULT_UPLOADS_DIR = isRender ? "/tmp/uploads" : "uploads";
const UPLOADS_DIR = process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR;
const TEMP_DIR = path.resolve(process.cwd(), UPLOADS_DIR);

// Ensure safe uploads path exists and is directory. If a file is found where directory expected, rename it.
try {
  if (fs.existsSync(TEMP_DIR)) {
    const stat = fs.statSync(TEMP_DIR);
    if (stat.isFile()) {
      const bak = `${TEMP_DIR}.bak-${Date.now()}`;
      try {
        fs.renameSync(TEMP_DIR, bak);
        console.warn(`[upload] Found file at uploads path; renamed to ${bak}`);
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        console.log(`[upload] Created uploads dir after renaming file: ${TEMP_DIR}`);
      } catch (e) {
        console.error(`[upload] Failed to rename file at uploads path (${TEMP_DIR}):`, e?.message || e);
        const alt = `${TEMP_DIR}-${Date.now()}`;
        fs.mkdirSync(alt, { recursive: true });
        console.warn(`[upload] Created alternate uploads dir: ${alt}`);
      }
    } else if (!stat.isDirectory()) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
  } else {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`[upload] Created uploads directory: ${TEMP_DIR}`);
  }
} catch (e) {
  console.warn("[upload] Could not ensure uploads dir; continuing (memory uploads recommended):", e?.message || e);
}

/* ------------------------------- Multer / Temp --------------------------- */
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_BYTES || DEFAULT_MAX_BYTES);

let storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = path
      .basename(file.originalname || "image", ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .slice(0, 120);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

if (USE_MEMORY_UPLOAD) storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    const err = new Error("Only JPG, PNG, WEBP or GIF allowed");
    err.status = 415;
    return cb(err);
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
    if (fp && typeof fp === "string" && fs.existsSync(fp)) fs.unlinkSync(fp);
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
      const parts = p.split("/").filter(Boolean);
      if (parts.length) return parts.slice(-2).join("/").replace(/\.[a-z0-9]+$/i, "");
      return null;
    }
    return s;
  } catch (_e) {
    return null;
  }
}

async function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const upload_stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    streamifier.createReadStream(buffer).pipe(upload_stream);
  });
}

const sanitizeFolder = (v) =>
  String(v || "").replace(/[^a-zA-Z0-9/_-]/g, "").replace(/(^\/+|\/+$)/g, "") || "uploads";

// convenience helper to set small CORS header for responses from this router (not a replacement for server-level CORS)
function maybeSetCorsHeader(res, req) {
  if (!process.env.CORS_ORIGIN) return;
  res.setHeader("Vary", "Origin");
  const allowList = String(process.env.CORS_ORIGIN).split(",").map(s => s.trim());
  const origin = req.headers.origin;
  if (origin && allowList.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  else res.setHeader("Access-Control-Allow-Origin", allowList[0]);
}

/* ------------------------------- Routes --------------------------------- */

// health
router.get("/ping", (_req, res) => {
  if (process.env.CORS_ORIGIN) res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN);
  return res.json({ ok: true, where: "upload.routes.js (safer)", timestamp: new Date().toISOString() });
});

// quick mode introspection
router.get("/mode", (_req, res) => {
  res.json({
    ok: true,
    useMemory: USE_MEMORY_UPLOAD,
    uploadsDir: TEMP_DIR,
    cloud: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
  });
});

function authWrapper(middlewares) {
  if (PUBLIC_UPLOADS) return (_req, _res, next) => next();
  return middlewares;
}

/**
 * POST /api/upload
 * - field name: "image"
 * - if USE_MEMORY_UPLOAD=true: streams memory buffer to Cloudinary (no disk)
 */
router.post("/", authWrapper([requireAuth, requireAdmin]), (req, res) => {
  upload.single("image")(req, res, async (err) => {
    maybeSetCorsHeader(res, req);

    const toMB = (n) => (n / (1024 * 1024)).toFixed(1);

    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: `Max file size is ${toMB(MAX_FILE_SIZE_BYTES)} MB` });
      }
      if (err.status === 415) {
        return res.status(415).json({ ok: false, error: err.message });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: err.message || "Upload failed" });
      }
      return res.status(400).json({ ok: false, error: err?.message || "Upload failed" });
    }

    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded (field: image)" });

    const requestedFolder = sanitizeFolder(
      (req.body && req.body.folder) || req.query?.folder || process.env.CLOUDINARY_FOLDER || "uploads"
    );
    const hasCloudinaryCreds = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

    try {
      let result;
      if (USE_MEMORY_UPLOAD && req.file.buffer) {
        if (hasCloudinaryCreds) {
          result = await uploadBufferToCloudinary(req.file.buffer, {
            folder: requestedFolder,
            resource_type: "image",
            use_filename: true,
            unique_filename: true,
          });
        } else {
          // fallback local write (use TEMP_DIR which was ensured earlier)
          const localFilename = `${Date.now()}-${req.file.originalname}`.replace(/\s+/g, "-");
          const localPath = path.join(TEMP_DIR, localFilename);
          fs.writeFileSync(localPath, req.file.buffer);
          result = { secure_url: `/uploads/${localFilename}`, public_id: localFilename };
        }
      } else {
        // disk mode (req.file.path should be safe)
        const fp = req.file.path;
        if (hasCloudinaryCreds) {
          result = await cloudinary.uploader.upload(fp, {
            folder: requestedFolder,
            resource_type: "image",
            use_filename: true,
            unique_filename: true,
          });
          // remove temp file after upload
          safeUnlink(fp);
        } else {
          const localFilename = path.basename(fp);
          result = { secure_url: `/uploads/${localFilename}`, public_id: localFilename };
        }
      }

      const payload = {
        ok: true,
        url: result.secure_url,
        public_id: result.public_id || extractPublicId(result.secure_url) || null,
        folder: requestedFolder,
        size: req.file.size,
        mimetype: req.file.mimetype,
      };

      res.setHeader("Location", result.secure_url);
      if (DEBUG_UPLOAD) payload.raw = result;
      return res.status(201).json(payload);
    } catch (cloudErr) {
      console.error("[upload] upload error:", cloudErr);
      if (req.file && req.file.path) safeUnlink(req.file.path);
      return res
        .status(cloudErr?.http_code || 500)
        .json({ ok: false, error: "Cloud upload failed", details: cloudErr?.message });
    }
  });
});

/* -------------------------- other endpoints (multiple/delete) -------------------------- */

router.post("/multiple", authWrapper([requireAuth, requireAdmin]), (req, res) => {
  upload.array("images", 6)(req, res, async (err) => {
    maybeSetCorsHeader(res, req);

    const toMB = (n) => (n / (1024 * 1024)).toFixed(1);

    if (err) {
      if (err.code === "LIMIT_FILE_SIZE")
        return res.status(413).json({ ok: false, error: `Max file size is ${toMB(MAX_FILE_SIZE_BYTES)} MB per file` });
      if (err.status === 415) return res.status(415).json({ ok: false, error: err.message });
      if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, error: err.message || "Upload failed" });
      return res.status(400).json({ ok: false, error: err?.message || "Upload failed" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "No files uploaded (field: images[])" });

    const requestedFolder = sanitizeFolder(
      (req.body && req.body.folder) || req.query?.folder || process.env.CLOUDINARY_FOLDER || "uploads"
    );
    const out = [];

    for (const f of files) {
      try {
        let r;
        const hasCloudinaryCreds = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
        if (USE_MEMORY_UPLOAD && f.buffer) {
          if (hasCloudinaryCreds) r = await uploadBufferToCloudinary(f.buffer, { folder: requestedFolder, resource_type: "image" });
          else {
            const localFilename = `${Date.now()}-${f.originalname}`.replace(/\s+/g, "-");
            const localPath = path.join(TEMP_DIR, localFilename);
            fs.writeFileSync(localPath, f.buffer);
            r = { secure_url: `/uploads/${localFilename}`, public_id: localFilename };
          }
        } else {
          if (hasCloudinaryCreds) r = await cloudinary.uploader.upload(f.path, { folder: requestedFolder, resource_type: "image" });
          else r = { secure_url: `/uploads/${path.basename(f.path)}`, public_id: path.basename(f.path) };
        }
        out.push({ ok: true, url: r.secure_url, public_id: r.public_id, size: f.size, mimetype: f.mimetype });
      } catch (e) {
        console.error("[upload/multiple] one file failed", e?.message || e);
      } finally {
        if (f && f.path && fs.existsSync(f.path)) safeUnlink(f.path);
      }
    }

    return res.status(201).json({ ok: true, files: out, count: out.length, folder: requestedFolder });
  });
});

router.delete("/:id", authWrapper([requireAuth, requireAdmin]), async (req, res) => {
  maybeSetCorsHeader(res, req);
  try {
    const { id } = req.params;
    const publicId = extractPublicId(id) || id;
    if (!publicId) return res.status(400).json({ ok: false, error: "Invalid id/url" });

    const hasCloud = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

    if (hasCloud) {
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      if (result.result === "not found") return res.status(404).json({ ok: false, message: "Image not found", result });
      return res.json({ ok: true, message: "Deleted", result });
    }

    // local fallback
    const basename = publicId.split("/").pop();
    const localPath = path.join(TEMP_DIR, basename);
    if (!fs.existsSync(localPath)) return res.status(404).json({ ok: false, message: "Image not found locally" });
    safeUnlink(localPath);
    return res.json({ ok: true, message: "Deleted (local)", file: basename });
  } catch (e) {
    console.error("[upload] delete error:", e);
    return res.status(500).json({ ok: false, error: "Failed to delete image", details: e?.message });
  }
});

/* -------------------------- Multer Error Handler ------------------------- */
router.use((err, _req, res, next) => {
  if (process.env.CORS_ORIGIN) res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN);
  const toMB = (n) => (n / (1024 * 1024)).toFixed(1);

  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: `Max file size is ${toMB(MAX_FILE_SIZE_BYTES)} MB` });
  }
  if (err && (err.name === "MulterError" || err.status === 415)) {
    return res.status(err.status || 400).json({ ok: false, error: err.message });
  }
  return next(err);
});

export default router;
