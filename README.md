# 🎬 Movie Ticket Booking – Backend API

RESTful API for movies, showtimes, seat locking, bookings, payments, notifications, and admin scheduling.

# 🏗 Tech

Node.js + Express

MongoDB + Mongoose

JWT Auth (access + refresh)

Razorpay

Nodemailer (email)

BullMQ/Agenda (optional) for background jobs

Socket.IO (optional) for real-time seat updates

Helmet/CORS/Rate-limit security


# 🗄 MongoDB Models (core)

User: { name, email, phone, passwordHash, roles, prefs }

Theater: { name, address, geo, contact }

Screen: { theaterId, name, layout: { rows, cols, aisles, seatTypes } }

Movie: { tmdbId, title, genres, runtime, rating, poster, backdrop, cast }

ShowTime: { movieId, theaterId, screenId, startAt, endAt, language, format, basePrice, dynamicPricingRules, status }

SeatMap (derived by screen) – static layout

Hold: { showtimeId, seatIds[], userId, expiresAt, status }

Booking: { showtimeId, userId, seatIds[], amount, status, qrCode, reference }

Payment: { provider, providerRef, bookingId, amount, currency, status, meta }

# 🔒 Seat Locking Strategy

POST /seats/hold with {showtimeId, seatIds}

Ensure seats are not booked/held by others

Create Hold with expiresAt = now + 10m

PATCH /seats/hold/:id/refresh to extend hold

POST /bookings/confirm with paymentIntentId/orderId

Validate payments (provider confirm)

Mark seats booked, close hold

Job cleans expired holds every minute

Optimistic UI updates via Socket.IO

# ⚙️ Environment

Create backend/.env:

# Core
PORT=8080

NODE_ENV=production

CLIENT_URL=https://your-frontend.netlify.app

MONGO_URI=mongodb+srv://user:pass@cluster/dbname

JWT_ACCESS_SECRET=base64_256bit_here

JWT_REFRESH_SECRET=base64_256bit_here

# Payments 

PAYMENT_PROVIDER=razorpay                

RAZORPAY_KEY_ID=rzp_test_xxx

RAZORPAY_KEY_SECRET=xxx

RAZORPAY_WEBHOOK_SECRET=whsec_xxx

# Email/SMS

SMTP_HOST=smtp.gmail.com

SMTP_PORT=587

SMTP_USER=rajarajeshwaripandikumar@gmail.com

SMTP_PASS=app_password


# 📚 API (high level)

# Auth

POST /api/auth/register – email+password or phone OTP

POST /api/auth/login

POST /api/auth/refresh

POST /api/auth/logout

GET /api/users/me

# Movies & Showtimes

GET /api/movies?title=&genre=&date=YYYY-MM-DD

GET /api/movies/:id

GET /api/showtimes?movieId=&theaterId=&date=YYYY-MM-DD

GET /api/showtimes/:id

# Seats

GET /api/seats/availability?showtimeId=...

POST /api/seats/hold { showtimeId, seatIds[] }

PATCH /api/seats/hold/:holdId/refresh

DELETE /api/seats/hold/:holdId (release)

# Payments

POST /api/payments/create-intent (Stripe) { bookingDraft }

POST /api/payments/create-order (Razorpay)

POST /api/payments/webhook (provider webhook)

# Bookings

POST /api/bookings/confirm – finalize after payment

GET /api/bookings/my – list current user’s bookings

GET /api/bookings/:id – details, QR

POST /api/bookings/:id/cancel – follow theater policy

GET /api/bookings/:id/ticket.pdf – download

# Admin (secure: role = admin)

POST /api/admin/theaters / PATCH / DELETE

POST /api/admin/screens (layout JSON) / PATCH / DELETE

POST /api/admin/showtimes / PATCH / DELETE

PATCH /api/admin/pricing (base + dynamic rules)

GET /api/admin/reports?from=&to=

# Reports

Sales, occupancy, top movies, no-shows

Export CSV via /api/admin/reports/export

# 💳 Payment Flow

Client requests intent/order → server creates  Razorpay Order

Client pays (Razorpay Checkout)

Webhook verifies success → server marks Payment=Succeeded, creates/updates Booking

Server emails/SMS booking confirmation with QR

# ✉️ Notifications

Emails (Nodemailer) + SMS (Twilio):

Booking confirmation (movie, time, seats, receipt)


# 🚀 Local Dev

npm i

npm run dev
