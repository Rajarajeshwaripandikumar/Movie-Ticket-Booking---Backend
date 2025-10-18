const MovieSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    genre: { type: String, default: '' },
    releaseDate: { type: Date },
    durationMins: { type: Number, default: 0 },
    language: { type: String, default: 'English' },
    cast: { type: [String], default: [] },
    director: { type: String, default: '' },
    rating: { type: Number, min: 0, max: 10, default: 0 },

    // ✅ Poster stored as backend-served or S3/Cloudinary URL
    posterUrl: { type: String, default: '' },

    // ✅ Who uploaded or last updated poster (for admin trace)
    uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploaderRole: { type: String, default: 'admin' },
  },
  { timestamps: true }
);
