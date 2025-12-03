// src/services/paymentService.js
import razorpay from "../config/razorpay.js"; // your razorpay instance
import PaymentIntent from "../models/PaymentIntent.js";

/**
 * Create Razorpay order idempotently and store PaymentIntent
 * - amount (in rupees) passed by business logic; we convert to paise
 * - idempotencyKey required from client to dedupe
 */
export async function createRazorpayOrder({
  bookingId = null,
  userId = null,
  showtimeId = null,
  seats = [],
  amount = 0, // rupees
  idempotencyKey,
}) {
  if (!idempotencyKey) throw new Error("idempotencyKey required");

  // convert to paise (integer)
  const amountPaise = Math.round(amount * 100);

  // Try to find an existing PaymentIntent created with this idempotencyKey
  let pi = await PaymentIntent.findOne({ idempotencyKey });
  if (pi) {
    // If already created, return existing order details
    if (pi.providerOrderId && pi.status === "CREATED") {
      return { existing: true, paymentIntent: pi };
    }
    // If found but in other state, return it too
    return { existing: true, paymentIntent: pi };
  }

  // create Razorpay order
  const options = {
    amount: amountPaise,
    currency: "INR",
    receipt: `booking_${bookingId || "guest"}_${Date.now()}`,
    notes: {
      bookingId: bookingId?.toString?.() || null,
      userId: userId?.toString?.() || null,
      seats: seats.join(","),
      idempotencyKey,
    },
  };

  const order = await razorpay.orders.create(options);

  // persist PaymentIntent
  pi = await PaymentIntent.create({
    booking: bookingId || null,
    showtime: showtimeId || null,
    seats,
    amount,
    amountPaise,
    status: "CREATED",
    provider: "razorpay",
    providerOrderId: order.id,
    raw: order,
    idempotencyKey,
    user: userId || null,
  });

  return { existing: false, paymentIntent: pi, order };
}

/**
 * Mark PaymentIntent as succeeded (after verifying signature)
 */
export async function markPaymentSucceeded({ idempotencyKey, providerOrderId, providerPaymentId, providerPayload = {} }) {
  const query = idempotencyKey ? { idempotencyKey } : { providerOrderId };
  const pi = await PaymentIntent.findOne(query);
  if (!pi) throw new Error("PaymentIntent not found");

  pi.status = "SUCCEEDED";
  pi.providerPaymentId = providerPaymentId;
  pi.raw = { ...(pi.raw || {}), providerPayload };
  await pi.save();
  return pi;
}
