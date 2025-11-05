// backend/src/routes/superadmin.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../models/User.js";
import Theater from "../models/Theater.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
// ✅ ensure it mounts at /api/superadmin (server.js uses routesPrefix if present)
router.routesPrefix = "/api/superadmin";

/* -------------------------------------------------------------------------- */
/* 🎭 Create Theatre Admin (SUPER_ADMIN only)                                  */
/* POST /api/superadmin/create-theatre-admin                                   */
/* Body: { name, email, password, theatreId }                                  */
/* -------------------------------------------------------------------------- */
router.post(
  "/create-theatre-admin",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { name, email, password, theatreId } = req.body;

      if (!name || !email || !password || !theatreId) {
        return res.status(400).json({ message: "All fields are required" });
      }
      if (!mongoose.isValidObjectId(String(theatreId))) {
        return res.status(400).json({ message: "Invalid theatreId" });
      }

      // 409 #1: email already used
      const existingByEmail = await User.findOne({ email }).select("_id");
      if (existingByEmail) {
        return res.status(409).json({ message: "Email already exists" });
      }

      const theatre = await Theater.findById(theatreId).select("_id name city");
      if (!theatre) return res.status(404).json({ message: "Theatre not found" });

      // 409 #2: theatre already has an admin
      const existingAdminForTheatre = await User.findOne({
        role: { $in: ["THEATER_ADMIN", "THEATRE_ADMIN"] },
        theatreId: theatreId,
      }).select("_id");
      if (existingAdminForTheatre) {
        return res.status(409).json({ message: "Theatre already has an admin" });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const newAdmin = await User.create({
        name,
        email,
        password: hashedPassword,
        role: "THEATER_ADMIN", // store canonical; frontend maps both
        theatreId,
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
      return res.status(500).json({ message: "Failed to create theatre admin", error: err.message });
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
        .sort({ createdAt: -1, _id: -1 });

      return res.json(admins);
    } catch (err) {
      console.error("[SuperAdmin] list theatre admins error:", err);
      return res.status(500).json({ message: "Failed to load theatre admins", error: err.message });
    }
  }
);

export default router;
