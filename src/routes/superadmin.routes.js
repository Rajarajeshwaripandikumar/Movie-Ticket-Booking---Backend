// backend/src/routes/superadmin.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Theater from "../models/Theater.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* 🎭 Create Theatre Admin (SUPER_ADMIN only)                                  */
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

      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ message: "Email already exists" });

      const theatre = await Theater.findById(theatreId);
      if (!theatre) return res.status(404).json({ message: "Theatre not found" });

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const newAdmin = await User.create({
        name,
        email,
        password: hashedPassword,
        role: "THEATRE_ADMIN",
        theatreId,
      });

      res.status(201).json({
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
      res.status(500).json({ message: "Failed to create theatre admin", error: err.message });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* 🏢 View All Theatre Admins                                                  */
/* -------------------------------------------------------------------------- */
router.get(
  "/theatre-admins",
  requireAuth,
  requireRoles("SUPER_ADMIN"),
  async (_req, res) => {
    try {
      const admins = await User.find({ role: "THEATRE_ADMIN" })
        .populate("theatreId", "name city")
        .select("name email theatreId createdAt");
      res.json(admins);
    } catch (err) {
      console.error("[SuperAdmin] list theatre admins error:", err);
      res.status(500).json({ message: "Failed to load theatre admins", error: err.message });
    }
  }
);

export default router;
