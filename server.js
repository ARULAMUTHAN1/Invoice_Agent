require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const invoiceRoutes = require('./routes/invoice');
const chatRoutes    = require('./routes/chat');
const authRoutes    = require('./routes/auth');
const authMiddleware = require('./middleware/auth');
const dbCheck        = require('./middleware/dbCheck');

// ─── App Initialisation ────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 5000;

// ─── Ensure uploads directory exists ──────────────────────────────────────
const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '11mb' }));
app.use(express.urlencoded({ extended: true, limit: '11mb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files statically (useful for previewing invoices)
app.use('/uploads', express.static(uploadDir));

// ─── Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',    dbCheck, authRoutes);
app.use('/api/invoice', dbCheck, authMiddleware, invoiceRoutes);
app.use('/api/chat',    dbCheck, authMiddleware, chatRoutes);

// Health-check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Global Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

// ─── MongoDB Connection ────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅  MongoDB connected successfully');
  } catch (err) {
    console.error('❌  MongoDB connection error:', err.message);
    console.warn('⚠️  Server is running in offline/degraded mode without database connectivity.');
  }
};

// ─── Start Server ──────────────────────────────────────────────────────────
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀  Invoice Processing Agent running on http://localhost:${PORT}`);
    console.log(`📂  Upload directory: ${uploadDir}`);
    console.log(`🌿  Environment: ${process.env.NODE_ENV || 'development'}`);
  });
};

startServer();

module.exports = app; // exported for testing
