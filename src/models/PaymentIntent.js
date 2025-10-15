import mongoose from 'mongoose';

const paymentIntentSchema = new mongoose.Schema({
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  showtime: { type: mongoose.Schema.Types.ObjectId, ref: 'Showtime' },
  seats: { type: [String], default: [] },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['REQUIRES_PAYMENT','SUCCEEDED','FAILED','CANCELED'], default: 'REQUIRES_PAYMENT' },
  provider: { type: String, default: 'mock' },
  providerIntentId: { type: String },
  idempotencyKey: { type: String, unique: true, sparse: true }
}, { timestamps: true });

export default mongoose.model('PaymentIntent', paymentIntentSchema);
