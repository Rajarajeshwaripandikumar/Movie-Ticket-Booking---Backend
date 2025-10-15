import mongoose from 'mongoose';

const screenSchema = new mongoose.Schema({
  theater: { type: mongoose.Schema.Types.ObjectId, ref: 'Theater', required: true },
  name: { type: String, required: true },
  rows: { type: Number, required: true },
  cols: { type: Number, required: true }
}, { timestamps: true });

screenSchema.index({ theater: 1, name: 1 }, { unique: true });

export default mongoose.model('Screen', screenSchema);
