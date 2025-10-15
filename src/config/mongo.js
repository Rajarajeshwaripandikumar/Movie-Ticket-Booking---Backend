// backend/src/config/mongo.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI || 'mongodb+srv://rajarajeshwaripandikumar_db_1:Pandikumar1%40@moviebooking.yczhqy5.mongodb.net/movie-booking?retryWrites=true&w=majority&appName=moviebooking';

export default async function connectDB() {
  try {
    console.log('→ Connecting to MongoDB ...');
    await mongoose.connect(uri, {
      autoIndex: true,
      serverSelectionTimeoutMS: 20000,
      connectTimeoutMS: 20000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB connected');
    mongoose.connection.on('error', (err) => console.error('Mongo error', err));
    mongoose.connection.on('disconnected', () => console.warn('Mongo disconnected'));
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err && err.message ? err.message : err);
    throw err;
  }
}
