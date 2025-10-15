import SeatLock from '../models/SeatLock.js';
import Showtime from '../models/Showtime.js';
import Booking from '../models/Booking.js';

const LOCK_MINUTES = parseInt(process.env.SEAT_LOCK_MINUTES || '10', 10);

export async function getUnavailableSeats(showtimeId){
  const st = await Showtime.findById(showtimeId).lean();
  if(!st) throw new Error('Showtime not found');
  const now = new Date();
  const locks = await SeatLock.find({ showtime: showtimeId, lockedUntil: { $gt: now } }).lean();
  const confirmed = await Booking.find({ showtime: showtimeId, status: 'CONFIRMED' }, { seats: 1, _id: 0 }).lean();
  const lockedSeats = locks.map(l => l.seat);
  const bookedSeats = confirmed.flatMap(b => b.seats);
  return new Set([ ...st.bookedSeats, ...bookedSeats, ...lockedSeats ]);
}

export async function lockSeats({ showtimeId, seats, userId }){
  const taken = await getUnavailableSeats(showtimeId);
  const conflicts = seats.filter(s => taken.has(s));
  if (conflicts.length) return { ok:false, conflicts };

  const until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
  const bulk = seats.map(seat => ({
    updateOne: {
      filter: { showtime: showtimeId, seat },
      update: { $setOnInsert: { showtime: showtimeId, seat, lockedBy: userId, lockedUntil: until } },
      upsert: true
    }
  }));
  try {
    await SeatLock.bulkWrite(bulk, { ordered: true });
    return { ok:true, lockedUntil: until };
  } catch (e) {
    return { ok:false, conflicts: seats };
  }
}

export async function releaseSeats({ showtimeId, seats, userId }){
  await SeatLock.deleteMany({ showtime: showtimeId, seat: { $in: seats }, lockedBy: userId });
  return { ok:true };
}
