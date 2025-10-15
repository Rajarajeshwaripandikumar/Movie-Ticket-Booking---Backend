import mongoose from 'mongoose';

const MovieSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    genre: { type: String, default: '' }, // or make it [String] if multi-genre
    releaseDate: { type: Date },
    durationMins: { type: Number, default: 0 },
    language: { type: String, default: 'English' },
    cast: { type: [String], default: [] },
    director: { type: String, default: '' },
    rating: { type: Number, min: 0, max: 10, default: 0 },
    posterUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

// ✅ Index for full-text search (used in search endpoints)
MovieSchema.index({
  title: 'text',
  description: 'text',
  cast: 'text',
  director: 'text',
});

// ✅ Model creation and export
const Movie = mongoose.model('Movie', MovieSchema);
export default Movie;
