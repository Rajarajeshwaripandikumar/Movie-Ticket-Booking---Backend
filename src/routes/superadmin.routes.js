// backend/src/routes/superadmin.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../models/User.js";
import Theater from "../models/Theater.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
// Mount at /api/superadmin (server.js should honor routesPrefix if implemented)
router.routesPrefix = "/api/superadmin";

/* utils */
const normEmail = (e) => String(e || "").trim().toLowerCase();
const isObjId = (v) => mongoose.isValidObjectId(String(v || ""));

/* -------------------------------------------------------------------------- */
/* 🎭 Create Theatre Admin (SUPER_ADMIN only)                                  */
/* POST /api/superadmin/create-theatre-admin                                   */
/* Body: { name, email, password, theatreId | theaterId }                      */
/* -------------------------------------------------------------------------- */
router.post(
  "/create-theatre-admin",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const email = normEmail(req.body?.email);
      const password = String(req.body?.password || "");
      // accept both spellings; store on User as `theatreId` if your schema uses that
      const theatreId = req.body?.theatreId || req.body?.theaterId;

      if (!name || !email || !password || !theatreId) {
        return res.status(400).json({ code: "BAD_REQUEST", message: "name, email, password, theatreId required" });
      }
      if (!isObjId(theatreId)) {
        return res.status(400).json({ code: "INVALID_THEATRE_ID", message: "Invalid theatreId" });
      }

      // 409 #1: email already used (case-insensitive)
      const existingByEmail = await User.findOne({ email }).select("_id").lean();
      if (existingByEmail) {
        return res.status(409).json({ code: "EMAIL_TAKEN", message: "Email already exists" });
      }

      const theatre = await Theater.findById(theatreId).select("_id name city").lean();
      if (!theatre) {
        return res.status(404).json({ code: "THEATER_NOT_FOUND", message: "Theatre not found" });
      }

      // 409 #2: theatre already has an admin
      const existingAdmin = await User.findOne({
        role: { $in: ["THEATER_ADMIN", "THEATRE_ADMIN"] },
        // 🔑 keep this field name aligned with your User schema
        theatreId: theatreId,
      }).select("_id").lean();

      if (existingAdmin) {
        return res.status(409).json({ code: "THEATER_ALREADY_HAS_ADMIN", message: "Theatre already has an admin" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newAdmin = await User.create({
        name,
        email,                   // already lowercased
        password: hashedPassword,
        role: "THEATER_ADMIN",   // canonical
        theatreId,               // keep same field name as in your User model
      });

      return res.status(201).json({
        message: "Theatre admin created successfully",
        admin: {
          id: newAdmin._id,
          name: newAdmin.name,
          email: newAdmin.email,
          theatreId: newAdmin.theatreId,
        },
      });
    } catch (err) {
      console.error("[SuperAdmin] create theatre admin error:", err);
      return res.status(500).json({ code: "INTERNAL", message: "Failed to create theatre admin" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* 🏢 View All Theatre Admins (SUPER_ADMIN)                                    */
/* GET /api/superadmin/theatre-admins                                          */
/* -------------------------------------------------------------------------- */
router.get(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (_req, res) => {
    try {
      const admins = await User.find({
        role: { $in: ["THEATER_ADMIN", "THEATRE_ADMIN"] },
      })
        .populate("theatreId", "name city")
        .select("name email theatreId createdAt")
        .sort({ createdAt: -1, _id: -1 })
        .lean();

      return res.json({ data: admins });
    } catch (err) {
      console.error("[SuperAdmin] list theatre admins error:", err);
      return res.status(500).json({ code: "INTERNAL", message: "Failed to load theatre admins" });
    }
  }
);

export default router;
