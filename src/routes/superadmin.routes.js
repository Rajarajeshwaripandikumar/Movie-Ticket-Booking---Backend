// backend/src/routes/superadmin.routes.js
import { Router } from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Theater from "../models/Theater.js";
import Showtime from "../models/Showtime.js";
// use the new roles middleware (factory style)
import { requireAuth, requireRole } from "../middleware/roles.js";

const router = Router();
// Optional: used by your server to mount with a prefix
router.routesPrefix = "/api/superadmin";

/* ------------------------------ utils ------------------------------------ */
const normEmail = (e) => String(e || "").trim().toLowerCase();
const isObjId = (v) => mongoose.isValidObjectId(String(v || ""));

/* ========================================================================== */
/* 🎭 THEATRE ADMINS                                                           */
/* ========================================================================== */
/* -------- controllers (so we can register both spellings cleanly) --------- */

async function createAdmin(req, res) {
  try {
    const name = String(req.body?.name || "").trim();
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const theatreId = req.body?.theatreId || req.body?.theaterId;

    if (!name || !email || !password || !theatreId) {
      return res
        .status(400)
        .json({ code: "BAD_REQUEST", message: "name, email, password, theatreId required" });
    }

    if (!isObjId(theatreId)) {
      return res.status(400).json({ code: "INVALID_THEATRE_ID", message: "Invalid theatreId" });
    }

    if (password.length < 8) {
      return res.status(400).json({ code: "WEAK_PASSWORD", message: "Password must be >= 8 characters" });
    }

    // ensure email uniqueness
    const existingByEmail = await User.findOne({ email }).select("_id").lean();
    if (existingByEmail) {
      return res.status(409).json({ code: "EMAIL_TAKEN", message: "Email already exists" });
    }

    // validate theatre exists
    const theatre = await Theater.findById(theatreId).select("_id name city").lean();
    if (!theatre) {
      return res.status(404).json({ code: "THEATER_NOT_FOUND", message: "Theatre not found" });
    }

    // ensure theatre doesn't already have a theatre-admin
    const existingAdmin = await User.findOne({
      role: "THEATRE_ADMIN",
      theatreId,
    })
      .select("_id")
      .lean();
    if (existingAdmin) {
      return res
        .status(409)
        .json({ code: "THEATER_ALREADY_HAS_ADMIN", message: "Theatre already has an admin" });
    }

    // create user (User.pre('save') will hash password)
    const newAdmin = await User.create({
      name,
      email,
      password,
      role: "THEATRE_ADMIN",
      theatreId,
      isActive: true,
    });

    // respond with safe shape
    return res.status(201).json({
      ok: true,
      message: "Theatre admin created successfully",
      admin: {
        id: newAdmin._id,
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
        theatreId: newAdmin.theatreId,
        isActive: newAdmin.isActive ?? true,
        createdAt: newAdmin.createdAt,
      },
    });
  } catch (err) {
    console.error("[SuperAdmin] create theatre admin error:", err);
    if (err?.name === "ValidationError") {
      return res.status(400).json({ code: "VALIDATION_ERROR", message: err.message });
    }
    if (err?.code === 11000) {
      return res.status(409).json({ code: "EMAIL_TAKEN", message: "Email already exists" });
    }
    return res.status(500).json({ code: "INTERNAL", message: "Failed to create theatre admin" });
  }
}

async function listAdmins(_req, res) {
  try {
    const admins = await User.find({ role: "THEATRE_ADMIN" })
      .populate("theatreId", "name city")
      .select("name email role theatreId isActive createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return res.json({ ok: true, data: admins });
  } catch (err) {
    console.error("[SuperAdmin] list theatre admins error:", err);
    return res.status(500).json({ code: "INTERNAL", message: "Failed to load theatre admins" });
  }
}

async function getAdmin(req, res) {
  try {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ code: "BAD_ID", message: "Invalid id" });

    const admin = await User.findOne({ _id: id, role: "THEATRE_ADMIN" })
      .populate("theatreId", "name city")
      .select("name email role theatreId isActive createdAt")
      .lean();

    if (!admin)
      return res.status(404).json({ code: "NOT_FOUND", message: "Theatre admin not found" });
    return res.json({ ok: true, admin });
  } catch (err) {
    console.error("[SuperAdmin] get theatre admin error:", err);
    res.status(500).json({ code: "INTERNAL", message: "Failed to load theatre admin" });
  }
}

async function updateAdmin(req, res) {
  try {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ code: "BAD_ID", message: "Invalid id" });

    const { name, email, theatreId, isActive } = req.body || {};
    if (
      typeof name !== "string" &&
      typeof email !== "string" &&
      typeof theatreId === "undefined" &&
      typeof isActive === "undefined"
    ) {
      return res.status(400).json({ code: "NOTHING_TO_UPDATE", message: "No fields to update" });
    }

    const update = {};

    if (typeof name === "string") update.name = name.trim();

    if (typeof email === "string") {
      const e = normEmail(email);
      const taken = await User.findOne({ email: e, _id: { $ne: id } })
        .select("_id")
        .lean();
      if (taken) return res.status(409).json({ code: "EMAIL_TAKEN", message: "Email already in use" });
      update.email = e;
    }

    if (typeof theatreId !== "undefined") {
      if (!isObjId(theatreId)) {
        return res.status(400).json({ code: "INVALID_THEATRE_ID", message: "Invalid theatreId" });
      }
      const theatre = await Theater.findById(theatreId).select("_id").lean();
      if (!theatre)
        return res.status(404).json({ code: "THEATER_NOT_FOUND", message: "Theatre not found" });

      const otherAdmin = await User.findOne({
        _id: { $ne: id },
        role: "THEATRE_ADMIN",
        theatreId,
      })
        .select("_id")
        .lean();
      if (otherAdmin) {
        return res
          .status(409)
          .json({ code: "THEATER_ALREADY_HAS_ADMIN", message: "Theatre already has an admin" });
      }
      update.theatreId = theatreId;
    }

    if (typeof isActive === "boolean") update.isActive = isActive;

    const doc = await User.findOneAndUpdate(
      { _id: id, role: "THEATRE_ADMIN" },
      { $set: update },
      { new: true, select: "name email role theatreId isActive createdAt" }
    ).lean();

    if (!doc)
      return res.status(404).json({ code: "NOT_FOUND", message: "Theatre admin not found" });

    return res.json({
      ok: true,
      message: "Theatre admin updated",
      admin: {
        id: doc._id,
        name: doc.name,
        email: doc.email,
        role: doc.role,
        theatreId: doc.theatreId,
        isActive: doc.isActive ?? true,
        createdAt: doc.createdAt,
      },
    });
  } catch (err) {
    console.error("[SuperAdmin] update theatre admin error:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ code: "EMAIL_TAKEN", message: "Email already in use" });
    }
    res.status(500).json({ code: "INTERNAL", message: "Failed to update theatre admin" });
  }
}

async function updateAdminStatus(req, res) {
  try {
    const { id } = req.params;
    const { isActive } = req.body || {};
    if (!isObjId(id)) return res.status(400).json({ code: "BAD_ID", message: "Invalid id" });
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ code: "BAD_REQUEST", message: "isActive boolean required" });
    }

    const doc = await User.findOneAndUpdate(
      { _id: id, role: "THEATRE_ADMIN" },
      { $set: { isActive } },
      { new: true, select: "name email role theatreId isActive createdAt" }
    ).lean();
    if (!doc)
      return res.status(404).json({ code: "NOT_FOUND", message: "Theatre admin not found" });

    return res.json({ ok: true, message: "Status updated", isActive: doc.isActive });
  } catch (err) {
    console.error("[SuperAdmin] status theatre admin error:", err);
    res.status(500).json({ code: "INTERNAL", message: "Failed to update status" });
  }
}

async function deleteAdmin(req, res) {
  try {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ code: "BAD_ID", message: "Invalid id" });

    const doc = await User.findOneAndDelete({ _id: id, role: "THEATRE_ADMIN" }).lean();
    if (!doc)
      return res.status(404).json({ code: "NOT_FOUND", message: "Theatre admin not found" });

    return res.json({ ok: true, message: "Theatre admin deleted", id });
  } catch (err) {
    console.error("[SuperAdmin] delete theatre admin error:", err);
    res.status(500).json({ code: "INTERNAL", message: "Failed to delete theatre admin" });
  }
}

/* -------------------------- route registrations --------------------------- */
// Accept both spellings: theatre-admins & theater-admins
const adminBases = ["theatre-admins", "theater-admins"];

// Legacy create route kept for backward compatibility
router.post(
  "/create-theatre-admin",
  requireAuth(),
  requireRole(["SUPER_ADMIN"]),
  createAdmin
);

// New conventional create routes
adminBases.forEach((base) => {
  router.post(
    `/${base}`,
    requireAuth(),
    requireRole(["SUPER_ADMIN"]),
    createAdmin
  );
  router.get(
    `/${base}`,
    requireAuth(),
    requireRole(["SUPER_ADMIN"]),
    listAdmins
  );
  router.get(
    `/${base}/:id`,
    requireAuth(),
    requireRole(["SUPER_ADMIN"]),
    getAdmin
  );
  router.put(
    `/${base}/:id`,
    requireAuth(),
    requireRole(["SUPER_ADMIN"]),
    updateAdmin
  );
  router.patch(
    `/${base}/:id/status`,
    requireAuth(),
    requireRole(["SUPER_ADMIN"]),
    updateAdminStatus
  );
  router.delete(
    `/${base}/:id`,
    requireAuth(),
    requireRole(["SUPER_ADMIN"]),
    deleteAdmin
  );
});

/* ========================================================================== */
/* 🎬 THEATERS (Manage Theaters page)                                          */
/* ========================================================================== */

/* List Theaters
   GET /api/superadmin/theaters?q=&city= */
router.get(
  "/theaters",
  requireAuth(),
  requireRole(["SUPER_ADMIN"]),
  async (req, res) => {
    try {
      const { q, city } = req.query || {};
      const filter = {};
      if (city) filter.city = String(city).trim();
      if (q) {
        const r = { $regex: String(q).trim(), $options: "i" };
        filter.$or = [{ name: r }, { city: r }, { address: r }];
      }

      const theaters = await Theater.find(filter).sort({ createdAt: -1 }).lean();
      return res.json({ ok: true, theaters });
    } catch (err) {
      console.error("[SuperAdmin] list theaters error:", err);
      return res.status(500).json({ ok: false, message: "Failed to load theaters" });
    }
  }
);

/* Create Theater
   POST /api/superadmin/theaters
   Body: { name, city, address?, imageUrl? } */
router.post(
  "/theaters",
  requireAuth(),
  requireRole(["SUPER_ADMIN"]),
  async (req, res) => {
    try {
      const { name, city, address = "", imageUrl = "" } = req.body || {};
      if (!name || !city)
        return res.status(400).json({ ok: false, message: "name & city required" });

      const doc = await Theater.create({
        name: String(name).trim(),
        city: String(city).trim(),
        address: String(address || ""),
        imageUrl: String(imageUrl || ""),
      });
      return res.status(201).json({ ok: true, theater: doc });
    } catch (err) {
      console.error("[SuperAdmin] create theater error:", err);
      if (err?.name === "ValidationError") {
        return res.status(400).json({ ok: false, message: err.message });
      }
      return res.status(500).json({ ok: false, message: "Failed to create theater" });
    }
  }
);

/* Update Theater
   PUT /api/superadmin/theaters/:id
   Body: { name?, city?, address?, imageUrl? } */
router.put(
  "/theaters/:id",
  requireAuth(),
  requireRole(["SUPER_ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjId(id)) return res.status(400).json({ ok: false, message: "bad id" });

      const { name, city, address, imageUrl } = req.body || {};
      const set = {};
      if (typeof name === "string") set.name = name.trim();
      if (typeof city === "string") set.city = city.trim();
      if (typeof address === "string") set.address = address;
      if (typeof imageUrl === "string") set.imageUrl = imageUrl;

      if (Object.keys(set).length === 0) {
        return res.status(400).json({ ok: false, message: "Nothing to update" });
      }

      const doc = await Theater.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
      if (!doc) return res.status(404).json({ ok: false, message: "not found" });

      return res.json({ ok: true, theater: doc });
    } catch (err) {
      console.error("[SuperAdmin] update theater error:", err);
      return res.status(500).json({ ok: false, message: "Failed to update theater" });
    }
  }
);

/* Delete Theater
   DELETE /api/superadmin/theaters/:id */
router.delete(
  "/theaters/:id",
  requireAuth(),
  requireRole(["SUPER_ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjId(id)) return res.status(400).json({ ok: false, message: "bad id" });
      const del = await Theater.findByIdAndDelete(id).lean();
      if (!del) return res.status(404).json({ ok: false, message: "not found" });
      return res.json({ ok: true, id });
    } catch (err) {
      console.error("[SuperAdmin] delete theater error:", err);
      return res.status(500).json({ ok: false, message: "Failed to delete theater" });
    }
  }
);

/* ========================================================================== */
/* 🎫 SHOWTIME PRICING                                                         */
/* ========================================================================== */
/* Update base ticket price for a showtime
   PUT /api/superadmin/showtimes/:showtimeId/pricing
   Body: { basePrice: number >= 1 } */
router.put(
  "/showtimes/:showtimeId/pricing",
  requireAuth(),
  requireRole(["SUPER_ADMIN"]),
  async (req, res) => {
    try {
      const { showtimeId } = req.params;
      const { basePrice } = req.body || {};

      if (!isObjId(showtimeId)) {
        return res.status(400).json({ code: "BAD_ID", message: "Invalid showtimeId" });
      }
      if (typeof basePrice !== "number" || !Number.isFinite(basePrice) || basePrice < 1) {
        return res.status(400).json({ code: "BAD_PRICE", message: "basePrice must be >= 1" });
      }

      const doc = await Showtime.findByIdAndUpdate(
        showtimeId,
        { $set: { basePrice } },
        { new: true }
      ).lean();

      if (!doc) return res.status(404).json({ code: "NOT_FOUND", message: "Showtime not found" });
      return res.json({ ok: true, message: "Pricing updated", showtime: doc });
    } catch (err) {
      console.error("[SuperAdmin] update pricing error:", err);
      return res.status(500).json({ code: "INTERNAL", message: "Failed to update pricing" });
    }
  }
);

export default router;
