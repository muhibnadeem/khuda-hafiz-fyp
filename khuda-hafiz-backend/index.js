if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: './.env' });
}
console.log("BACKEND MONGODB_URI =", process.env.MONGODB_URI);
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Service = require("./models/Service");
const Booking = require("./models/Booking");
const Package = require("./models/Package");
const Graveyard = require("./models/Graveyard");
const Feedback = require("./models/Feedback");
const defaultGraveyards = require("./seed/graveyards.data");
const graveyardRoutes = require("./routes/graveyard.routes");
const safepayRoutes = require("./safepay.routes");
const rateLimit = require("express-rate-limit");

async function ensureDefaultGraveyards() {
  const count = await Graveyard.countDocuments();
  if (count > 0) {
    console.log(`Graveyards already exist (${count}). Skipping default insert.`);
    return;
  }

  await Graveyard.insertMany(defaultGraveyards);
  console.log(`Inserted ${defaultGraveyards.length} default graveyards.`);
}


// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("MongoDB connected successfully");
    await ensureDefaultGraveyards();
  })
  .catch((err) => console.error("MongoDB connection error:", err));

const PORT = process.env.PORT || 3000;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

// --- Firebase Admin SDK initialization ---
try {
  let serviceAccount;
  const saPath = './serviceAccountKey.json';

  if (fs.existsSync(saPath)) {
    // Local development: load from file
    serviceAccount = require(saPath);
    console.log('Firebase: loaded from local file');
  } else if (process.env.FIREBASE_SA_CHUNK_1) {
    // Back4app: reassemble from 3 chunks
    const fullJson =
      (process.env.FIREBASE_SA_CHUNK_1 || '') +
      (process.env.FIREBASE_SA_CHUNK_2 || '') +
      (process.env.FIREBASE_SA_CHUNK_3 || '');
    serviceAccount = JSON.parse(fullJson);
    console.log('Firebase: loaded from chunked env variables');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Fallback: full JSON in one variable (for platforms with no limit)
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Firebase: loaded from single env variable');
  }

  if (!serviceAccount) {
    console.warn('No Firebase service account found. Firebase Admin will not be initialized.');
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin initialized');
  }
} catch (err) {
  console.error('Failed to initialize Firebase Admin:', err);
}

// --- Express setup ---
const app = express();
app.use(express.json());
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "khuda-hafiz-backend" });
});
app.use("/graveyards", graveyardRoutes);
app.use("/safepay", safepayRoutes);
// In-memory store for pending signup OTPs: { email -> { code, expiresAt } }
// NOTE: For production use a persistent store (Redis/DB) and rate-limiting.
const pendingOtps = new Map();

// In-memory store for pending login OTPs: { email -> { code, expiresAt, password } }
const pendingLoginOtps = new Map();

const isLoginOtpRequired = process.env.LOGIN_OTP_REQUIRED === 'true';

// Optional email sender (Resend) - configured via env
let resend = null;
try {
  const { Resend } = require('resend');
  if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
    console.log('Resend email sender configured');
  }
} catch (e) {
  console.warn('Resend not available or not configured');
}

function normalizeResendFrom(value) {
  const fallback = 'KhudaHafiz <onboarding@resend.dev>';
  const raw = String(value || '').trim();
  if (!raw) return fallback;

  const unquoted = raw.replace(/^['"]|['"]$/g, '').trim();
  const emailOnlyRe = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  const namedEmailRe = /^.+\s<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$/;

  if (emailOnlyRe.test(unquoted) || namedEmailRe.test(unquoted)) {
    return unquoted;
  }

  console.warn('Invalid RESEND_FROM format; falling back to onboarding sender.');
  return fallback;
}

async function sendResendEmail({ to, subject, html }) {
  if (!resend) {
    throw new Error('Resend not configured on server');
  }

  const from = normalizeResendFrom(process.env.RESEND_FROM);

  const { data, error } = await resend.emails.send({ from, to, subject, html });

  if (error) {
    const message = error.message || error.name || JSON.stringify(error);
    const err = new Error(message);
    err.resend = error;
    throw err;
  }

  return { provider: 'resend', id: data?.id, data };
}

// ✅ Signup endpoint
app.post("/signup", async (req, res) => {
  try {
    const { email, password, displayName, extra } = req.body;

    if (!email) return res.status(400).json({ error: "email required" });
    if (!FIREBASE_API_KEY) return res.status(500).json({ error: "Firebase API key not configured" });
    if (!password || !displayName) {
      return res.status(400).json({ error: 'password and displayName required' });
    }

    const signupResp = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      { email, password, returnSecureToken: true }
    );

    const firebaseData = signupResp.data;
    let tokenData = firebaseData;

    try {
      const updateResp = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_API_KEY}`,
        {
          idToken: firebaseData.idToken,
          displayName,
          returnSecureToken: true,
        }
      );
      tokenData = updateResp.data;
    } catch (profileErr) {
      console.warn("Firebase displayName update failed:", profileErr.response?.data || profileErr.message || profileErr);
    }

    res.json({
      token: {
        idToken: tokenData.idToken || firebaseData.idToken,
        refreshToken: tokenData.refreshToken || firebaseData.refreshToken,
      },
      profile: {
        uid: firebaseData.localId,
        email: firebaseData.email || email,
        displayName,
        ...extra,
      },
    });
  } catch (err) {
    console.error('Signup error:', err.response?.data || err.message || err);
    res.status(400).json({
      error: err.response?.data?.error?.message || err.response?.data || err.message || String(err),
    });
  }
});

// ✅ Login endpoint with OTP verification
app.post("/login", async (req, res) => {
  try {
    const { email, password, otp } = req.body;

    if (!email) return res.status(400).json({ error: "Email required" });

    const buildLoginResponse = (firebaseData) => ({
      token: {
        idToken: firebaseData.idToken,
        refreshToken: firebaseData.refreshToken,
      },
      profile: {
        uid: firebaseData.localId,
        email: firebaseData.email,
        displayName: firebaseData.displayName || email,
      },
    });

    // If no OTP provided, validate credentials and send OTP
    if (!otp) {
      if (!password) return res.status(400).json({ error: "Password required" });

      // Validate credentials with Firebase first
      let firebaseResp;
      try {
        firebaseResp = await axios.post(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
          { email, password, returnSecureToken: true }
        );
      } catch (err) {
        console.error("Credential validation failed:", err.response?.data || err.message);
        return res.status(400).json({
          error: err.response?.data?.error?.message || "Invalid email or password",
        });
      }

      if (!resend) {
        console.warn("Resend not configured; completing login without OTP.");
        return res.json(buildLoginResponse(firebaseResp.data));
      }

      // Rate-limit: prevent spamming OTPs
      const prev = pendingLoginOtps.get(email);
      if (prev && prev.expiresAt && prev.expiresAt - Date.now() > (9 * 60 * 1000)) {
        return res.status(429).json({ error: 'OTP recently sent. Please check your email.' });
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
      pendingLoginOtps.set(email, { code, expiresAt, password });

      try {
        const info = await sendResendEmail({
          to: email,
          subject: 'Your Khuda Hafiz login OTP',
          html: `<p>Your verification code is <strong>${code}</strong>. It will expire in 10 minutes.</p>`,
        });
        console.log('Login OTP sent via Resend', info.id || info);
        return res.json({ ok: true, message: 'OTP sent to email' });
      } catch (mailErr) {
        console.error('Failed to send login OTP via Resend:', mailErr);
        pendingLoginOtps.delete(email);

        if (!isLoginOtpRequired) {
          console.warn("Login OTP email failed; completing login without OTP because LOGIN_OTP_REQUIRED is not true.");
          return res.json(buildLoginResponse(firebaseResp.data));
        }

        return res.status(503).json({
          error: 'Failed to send OTP email',
          message: 'Your credentials are valid, but the server could not send the login OTP. Please try again later.',
          detail: mailErr.message || String(mailErr),
        });
      }
    }

    // OTP provided -> verify and complete login
    const record = pendingLoginOtps.get(email);
    if (!record) return res.status(400).json({ error: 'No OTP requested for this email' });
    if (record.expiresAt < Date.now()) {
      pendingLoginOtps.delete(email);
      return res.status(400).json({ error: 'OTP expired' });
    }
    if (record.code !== String(otp)) return res.status(400).json({ error: 'Invalid OTP' });

    // OTP verified, now authenticate with Firebase
    const firebaseResp = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      { email, password: record.password, returnSecureToken: true }
    );

    // cleanup
    pendingLoginOtps.delete(email);

    res.json(buildLoginResponse(firebaseResp.data));
  } catch (err) {
    console.error("Login error:", err.response?.data || err.message || err);
    res.status(400).json({
      error: err.response?.data?.error?.message || "Login failed. Check credentials",
    });
  }
});
// --- Submit feedback ---
app.post("/feedback", async (req, res) => {
  try {
    const { rating, message, userId, email, displayName } = req.body;
    const numericRating = Number(rating);

    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: "Rating must be a number from 1 to 5" });
    }

    const feedback = await Feedback.create({
      rating: numericRating,
      message: message || "",
      userId: userId || null,
      email: email || null,
      displayName: displayName || null,
    });

    res.status(201).json({ success: true, id: feedback._id.toString() });
  } catch (err) {
    console.error("Error saving feedback:", err);
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

// --- Retrieve feedbacks ---
app.get("/feedback", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const feedbackDocs = await Feedback.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const items = feedbackDocs.map((item) => ({
      id: item._id.toString(),
      ...item,
    }));

    res.json({ success: true, count: items.length, feedbacks: items });
  } catch (err) {
    console.error("Error fetching feedbacks:", err);
    res.status(500).json({ error: "Failed to fetch feedbacks" });
  }
});

// --- Delete a feedback ---
app.delete("/feedback/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Feedback ID is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid feedback ID" });
    }

    await Feedback.findByIdAndDelete(id);

    res.json({ success: true, message: "Feedback deleted successfully" });
  } catch (err) {
    console.error("Error deleting feedback:", err);
    res.status(500).json({ error: "Failed to delete feedback" });
  }
});

// --- Delete all feedbacks ---
app.delete("/feedback", async (req, res) => {
  try {
    const result = await Feedback.deleteMany({});

    res.json({ success: true, message: `Deleted ${result.deletedCount} feedbacks` });
  } catch (err) {
    console.error("Error deleting all feedbacks:", err);
    res.status(500).json({ error: "Failed to delete all feedbacks" });
  }
});


// Password reset: generate or send a password reset email
app.post('/reset-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Prefer Admin SDK to generate a link when Resend can send it server-side.
    if (admin.apps.length && resend) {
      try {
        const link = await admin.auth().generatePasswordResetLink(email);

        try {
          const info = await sendResendEmail({
            to: email,
            subject: 'Reset your Khuda Hafiz password',
            html: `<p>Click the link to reset your password:</p><p><a href="${link}">${link}</a></p>`,
          });
          console.log('Password reset email sent via Resend', info.id || info);
          return res.json({ ok: true, message: 'Password reset email sent' });
        } catch (mailErr) {
          console.error('Failed to send reset email via Resend:', mailErr);
          return res.status(500).json({ error: 'Failed to send reset email', detail: mailErr.message || String(mailErr) });
        }
      } catch (e) {
        console.warn('Admin generatePasswordResetLink failed:', e.message || e);
      }
    }

    // Fallback: use Firebase Auth REST API (requires FIREBASE_API_KEY)
    if (!FIREBASE_API_KEY) return res.status(500).json({ error: 'No Firebase admin or API key configured' });

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`;
    await axios.post(url, { requestType: 'PASSWORD_RESET', email });
    res.json({ ok: true, message: 'Password reset email sent' });
  } catch (err) {
    console.error('Reset password failed:', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Reset password failed', detail: err.response?.data || err.message });
  }
});

// --- Middleware: verifyAuth ---
const verifyAuth = async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Bearer token' });
    const idToken = auth.split(' ')[1];
    if (!admin.apps.length) return res.status(500).json({ error: 'Firebase Admin not initialized' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Auth error:", err.message || err);
    res.status(401).json({ error: 'Unauthorized', detail: err.message });
  }
};

// --- Search Graveyards Nearby ---
app.get("/graveyards/search", async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;

    // 1) Validate existence
    if (lat == null || lng == null) {
      return res.status(400).json({ success: false, error: "lat and lng are required" });
    }

    // 2) Parse + validate numeric
    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ success: false, error: "lat and lng must be valid numbers" });
    }

    // 3) Validate ranges
    if (latNum < -90 || latNum > 90) {
      return res.status(400).json({ success: false, error: "lat must be between -90 and 90" });
    }
    if (lngNum < -180 || lngNum > 180) {
      return res.status(400).json({ success: false, error: "lng must be between -180 and 180" });
    }

    // 4) Radius (meters) with sane defaults + cap
    let searchRadius = radius == null || radius === "" ? 5000 : Number(radius);

    if (!Number.isFinite(searchRadius) || searchRadius <= 0) {
      return res.status(400).json({ success: false, error: "radius must be a positive number (meters)" });
    }

    // cap radius to avoid abuse (e.g., 50km max)
    const MAX_RADIUS = 50000;
    if (searchRadius > MAX_RADIUS) searchRadius = MAX_RADIUS;

    // 5) Query (requires 2dsphere index on location)
    const nearbyGraveyards = await Graveyard.find({
      isActive: true,
      location: {
        $nearSphere: {
          $geometry: {
            type: "Point",
            coordinates: [lngNum, latNum], // [lng, lat]
          },
          $maxDistance: searchRadius,
        },
      },
    })
      .select("name address city location contactNumber") // keep payload small
      .lean();

    res.json({
      success: true,
      count: nearbyGraveyards.length,
      radiusUsed: searchRadius,
      graveyards: nearbyGraveyards,
    });
  } catch (err) {
    console.error("Error fetching graveyards:", err);
    res.status(500).json({ success: false, error: "Failed to fetch graveyards" });
  }
});


// Existing chat endpoint
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// --- Profile ---
app.get('/profile', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db = admin.firestore();
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile: snap.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// --- Logout ---
app.post('/logout', verifyAuth, async (req, res) => {
  try {
    if (!admin.apps.length) return res.status(500).json({ error: 'Firebase Admin not initialized' });
    const uid = req.user.uid;
    await admin.auth().revokeRefreshTokens(uid);
    res.json({ ok: true, message: 'Logout successful; refresh tokens revoked' });
  } catch (err) {
    console.error('Logout failed:', err);
    res.status(500).json({ error: 'Logout failed', detail: err.message || err });
  }
});
const normalizePaymentMode = (value) => {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();

  if (v === "online") return "online";
  if (v === "cash_on_delivery" || v === "cash on delivery" || v === "cod") {
    return "cash_on_delivery";
  }
  return null;
};

  // --- Book a package ---
app.post("/bookings", async (req, res) => {
  try {
    const { userId, packageName, items, totalPrice, paymentMode, paymentMethod } = req.body;

    if (!userId || !packageName || !items || totalPrice == null) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const normalizedPaymentMode = normalizePaymentMode(paymentMode || paymentMethod);
    if ((paymentMode || paymentMethod) && !normalizedPaymentMode) {
      return res.status(400).json({
        error: "Invalid payment mode. Use 'online' or 'cash_on_delivery'.",
      });
    }

    const booking = new Booking({
      userId,
      packageName,
      items,
      totalPrice,
      ...(normalizedPaymentMode ? { paymentMode: normalizedPaymentMode } : {}),
    });

    await booking.save();

    res.json({ success: true, booking });
  } catch (err) {
    console.error("Error creating booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});
app.get("/bookings", async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    res.json({ success: true, bookings });
  } catch (err) {
    console.error("Failed to fetch bookings:", err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});
  // --- Services (for Customize Package) ---
app.get("/services", async (req, res) => {
  try {
    const services = await Service.find();
    res.json(services);
  } catch (err) {
    console.error("Failed to fetch services:", err);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

app.get("/packages", async (req, res) => {
  try {
    const allServices = await Service.find();

    const basicServices = allServices.filter(s => 
      ["Flowers", "Kafan", "Catering"].includes(s.name)
    );

    const standardServices = allServices.filter(s =>
      ["Flowers", "Kafan", "Grave", "Catering"].includes(s.name)
    );

    const premiumServices = allServices; // all services

    const packages = [
      { type: "basic", items: basicServices },
      { type: "standard", items: standardServices },
      { type: "premium", items: premiumServices },
    ];

    res.json(packages);
  } catch (err) {
    console.error("Failed to fetch packages:", err);
    res.status(500).json({ error: "Failed to fetch packages" });
  }
});

// =========================
// ✅ Gemini Chatbot Endpoint
// =========================
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // 30 requests/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
});
async function classifyIntent(genAI, userMessage) {
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_CLASSIFIER_MODEL || process.env.GEMINI_MODEL || "gemini-flash-latest",
    systemInstruction:
      "You are an intent classifier for the Khuda Hafiz funeral booking app. " +
      "Return ONLY valid JSON. No markdown. No extra text."
  });

  const prompt = `
Classify the user's message into EXACTLY one intent and extract parameters.

Allowed intents:
- "get_services"
- "get_packages"
- "search_graveyards"
- "book_package"
- "general"

Output JSON schema:
{
  "intent": "<one of the allowed intents>",
  "params": { ... },
  "missing": ["field1", "field2"],
  "confidence": 0.0
}

Parameter rules:
- search_graveyards params: { "lat": number|null, "lng": number|null, "radius": number|null }
  missing must include "lat" and/or "lng" if not present.
- book_package params: { "packageType": "basic"|"standard"|"premium"|null, "city": string|null, "date": string|null, "time": string|null, "budget": number|null }
  missing list what is required if not present: packageType, city, date, time.
- get_services/get_packages: params can be empty.

User message: ${JSON.stringify(userMessage)}
`;

  const result = await model.generateContent(prompt);
  const raw = result?.response?.text?.() || "";

  // Try strict JSON parse
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    // Fallback: attempt to salvage JSON between first { and last }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {}
    }
    return { intent: "general", params: {}, missing: [], confidence: 0 };
  }
}
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message, history, userId } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required (string)" });
    }

    // ✅ Required for bookings (same as manual booking)
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "userId is required (string)" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY missing in .env" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // -------- City restriction helpers --------
    const ALLOWED_CITIES = ["Islamabad", "Rawalpindi", "Lahore"];

    function normalizeCity(input) {
      if (!input) return null;
      const c = String(input).trim().toLowerCase();
      if (c === "islamabad") return "Islamabad";
      if (c === "rawalpindi" || c === "pindi") return "Rawalpindi";
      if (c === "lahore") return "Lahore";
      return null;
    }

    function cityRestrictionReply() {
      return (
        "Currently our services are restricted to the following cities:\n" +
        "• Islamabad\n" +
        "• Rawalpindi\n" +
        "• Lahore\n\n" +
        "Please choose one of these cities to continue."
      );
    }

    // -------- History sanitizer (you already use this style) --------
    const safeHistory = Array.isArray(history)
      ? history
          .filter((h) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string")
          .map((h) => ({ role: h.role, parts: [{ text: h.text }] }))
      : [];

    // ✅ Extract booking details from last bot summary (so “confirm” works reliably)
    function extractLastBookingFromHistory(hist) {
      // Look for the last assistant message that contains the booking summary
      // Example we will send: Package: Basic | City: Lahore
      const lastModel = [...hist].reverse().find((h) => h.role === "model" && typeof h.text === "string");
      if (!lastModel) return null;

      const text = lastModel.text;

      // Very tolerant parsing
      const pkgMatch = text.match(/Package:\s*(basic|standard|premium)/i);
      const cityMatch = text.match(/City:\s*([A-Za-z\s]+)/i);

      const packageType = pkgMatch ? pkgMatch[1].toLowerCase() : null;
      const city = cityMatch ? normalizeCity(cityMatch[1]) : null;

      return { packageType, city };
    }

    // -------- Intent classification --------
    const intentResult = await classifyIntent(genAI, message);
    let intent = intentResult?.intent || "general";
    let params = intentResult?.params || {};

    // ✅ Backend-level confirm detection (no classifier changes needed)
    const m = message.trim().toLowerCase();
    const isConfirm = ["confirm", "yes", "y", "ok", "okay", "proceed", "book it"].includes(m);

    if (isConfirm) {
      intent = "confirm_booking";
      // try to get params from classifier first, else from history
      const fallback = extractLastBookingFromHistory(
        (Array.isArray(history) ? history : []).filter((h) => h && (h.role === "user" || h.role === "model"))
      );
      params = {
        packageType: params.packageType || fallback?.packageType || null,
        city: params.city || fallback?.city || null,
      };
    }

    // -------- DISPATCH --------

    if (intent === "get_services") {
      const services = await Service.find().select("name price description").lean();
      if (!services.length) return res.json({ reply: "No services are available right now." });

      const lines = services.map(
        (s) =>
          `• ${s.name}${s.price ? ` — ${s.price}` : ""}${s.description ? ` (${s.description})` : ""}`
      );

      return res.json({
        reply:
          "Here are the available services in Khuda Hafiz:\n" +
          lines.join("\n") +
          "\n\nIf you want, tell me your city and package (basic/standard/premium) and I’ll guide you."
      });
    }

    if (intent === "get_packages") {
      const allServices = await Service.find().lean();
      const pick = (names) => allServices.filter((s) => names.includes(s.name));

      const basic = pick(["Flowers", "Kafan", "Catering"]);
      const standard = pick(["Flowers", "Kafan", "Grave", "Catering"]);
      const premium = allServices;

      const fmt = (arr) => (arr.length ? arr.map((x) => x.name).join(", ") : "No items configured");

      return res.json({
        reply:
          `Here are the packages available in Khuda Hafiz:\n` +
          `• Basic: ${fmt(basic)}\n` +
          `• Standard: ${fmt(standard)}\n` +
          `• Premium: ${fmt(premium)}\n\n` +
          `Our services are currently available in: Islamabad, Rawalpindi, Lahore.\n` +
          `Tell me: package + city (e.g. "basic Lahore") to continue.`
      });
    }

    if (intent === "search_graveyards") {
      const lat = typeof params.lat === "number" ? params.lat : null;
      const lng = typeof params.lng === "number" ? params.lng : null;
      const radius = typeof params.radius === "number" ? params.radius : 5000;

      if (!lat || !lng) {
        return res.json({
          reply:
            "To find nearby graveyards, I need your location (latitude & longitude). " +
            "Please share your current location or allow location access in the app."
        });
      }

      const nearby = await Graveyard.find({
        isActive: true,
        location: {
          $nearSphere: {
            $geometry: { type: "Point", coordinates: [lng, lat] },
            $maxDistance: radius
          }
        }
      })
        .select("name address city contactNumber")
        .limit(10)
        .lean();

      if (!nearby.length) {
        return res.json({
          reply: `I couldn't find any active graveyards within ${radius} meters. Try increasing the radius.`
        });
      }

      const lines = nearby.map(
        (g) =>
          `• ${g.name}${g.city ? ` (${g.city})` : ""}\n  ${g.address || "Address not available"}${
            g.contactNumber ? ` | ${g.contactNumber}` : ""
          }`
      );

      return res.json({
        reply: `Here are nearby graveyards:\n${lines.join("\n")}\n\nIf you want, tell me which one you prefer and your preferred time.`
      });
    }

    // ✅ Step 1: Collect booking details (package + city), then ask confirm
    if (intent === "book_package") {
      const packageType = params.packageType ? String(params.packageType).toLowerCase() : null;
      const cityNorm = normalizeCity(params.city);

      if (params.city && !cityNorm) {
        return res.json({ reply: cityRestrictionReply() });
      }

      const need = [];
      if (!packageType) need.push("package type (basic / standard / premium)");
      if (!cityNorm) need.push("city (Islamabad / Rawalpindi / Lahore)");

      if (need.length) {
        return res.json({
          reply:
            "I can help you book a package. I just need:\n" +
            need.map((x) => `• ${x}`).join("\n") +
            "\n\nExample: “basic Lahore”"
        });
      }

      return res.json({
        reply:
          `Understood. Here’s what I have:\n` +
          `Package: ${packageType}\n` +
          `City: ${cityNorm}\n\n` +
          `Reply "confirm" to place the booking.`
      });
    }

    // ✅ Step 2: Confirm → create Booking in MongoDB EXACTLY like manual booking
    if (intent === "confirm_booking") {
      const packageType = params.packageType ? String(params.packageType).toLowerCase() : null;
      const cityNorm = normalizeCity(params.city);

      if (params.city && !cityNorm) {
        return res.json({ reply: cityRestrictionReply() });
      }

      const need = [];
      if (!packageType) need.push("package type (basic / standard / premium)");
      if (!cityNorm) need.push("city (Islamabad / Rawalpindi / Lahore)");

      if (need.length) {
        return res.json({
          reply:
            "Before I place the booking, I still need:\n" +
            need.map((x) => `• ${x}`).join("\n") +
            "\n\nExample: “standard Islamabad”"
        });
      }

      // Build items from Services (same as your packages logic)
      const allServices = await Service.find().lean();
      const pick = (names) => allServices.filter((s) => names.includes(s.name));

      let selected = [];
      let packageName = "";

      if (packageType === "basic") {
        selected = pick(["Flowers", "Kafan", "Catering"]);
        packageName = "Basic Package";
      } else if (packageType === "standard") {
        selected = pick(["Flowers", "Kafan", "Grave", "Catering"]);
        packageName = "Standard Package";
      } else if (packageType === "premium") {
        selected = allServices;
        packageName = "Premium Package";
      } else {
        return res.json({ reply: "Invalid package type. Use: basic, standard, premium." });
      }

      if (!selected.length) {
        return res.json({ reply: "No services configured for this package right now." });
      }

      const items = selected.map((s) => ({
        name: s.name,
        price: Number(s.price || 0),
      }));

      const totalPrice = items.reduce((sum, it) => sum + it.price, 0);

      // ✅ Create booking like manual booking (same schema)
      const booking = await Booking.create({
        userId,
        packageName,
        items,
        totalPrice,
        paymentMode: "cash_on_delivery",
        // status defaults to "pending"
      });

      return res.json({
        reply:
          "✅ Booking successful!\n\n" +
          `Booking ID: ${booking._id}\n` +
          `Package: ${packageName}\n` +
          `City: ${cityNorm}\n` +
          `Total: Rs ${totalPrice.toLocaleString()}\n\n` +
          "You can view details in Order Details."
      });
    }

    // -------- GENERAL CHAT fallback --------
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-flash-latest",
      systemInstruction:
        process.env.GEMINI_SYSTEM_PROMPT ||
        "You are the Khuda Hafiz Assistant for a digital funeral booking platform. Be respectful, concise, and do not invent prices or confirmations."
    });

    const chat = model.startChat({ history: safeHistory });
    const result = await chat.sendMessage(message);
    const reply = result?.response?.text?.() || "No reply from assistant.";

    return res.json({ reply });
  } catch (err) {
    console.error("Gemini chat error:", err);
    return res.status(500).json({
      error: "Chatbot error",
      details: String(err?.message || err)
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    email: {
      resendConfigured: Boolean(process.env.RESEND_API_KEY),
      resendFromConfigured: Boolean(process.env.RESEND_FROM),
      provider: "resend",
    },
    firebase: {
      adminConfigured: Boolean(admin.apps.length),
      apiKeyConfigured: Boolean(FIREBASE_API_KEY),
    },
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
