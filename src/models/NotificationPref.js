// models/NotificationPref.js
import mongoose from "mongoose";

const prefSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", unique: true },

    bookingConfirmed: { inApp:{type:Boolean, default:true}, email:{type:Boolean, default:true}, sms:{type:Boolean, default:false}, push:{type:Boolean, default:false} },
    bookingCancelled: { inApp:{type:Boolean, default:true}, email:{type:Boolean, default:true}, sms:{type:Boolean, default:false}, push:{type:Boolean, default:false} },

    bookingReminder:  { inApp:{type:Boolean, default:true}, email:{type:Boolean, default:true}, sms:{type:Boolean, default:false}, push:{type:Boolean, default:false} },
    showtimeChanged:  { inApp:{type:Boolean, default:true}, email:{type:Boolean, default:true}, sms:{type:Boolean, default:false}, push:{type:Boolean, default:false} },
    upcomingMovie:    { inApp:{type:Boolean, default:true}, email:{type:Boolean, default:false}, sms:{type:Boolean, default:false}, push:{type:Boolean, default:false} },

    timezone: { type: String, default: "Asia/Kolkata" },
  },
  { timestamps: true }
);

export default mongoose.model("NotificationPref", prefSchema);
