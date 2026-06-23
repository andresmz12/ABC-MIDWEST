require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./database');
const { initCron } = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // inline scripts throughout the app
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  crossOriginEmbedderPolicy: false
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// No-cache for all API responses
app.use('/api/', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// ── Rate limiters ──────────────────────────────────────────────────────────────

// General API umbrella — keeps bots and scanners from hammering every endpoint
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 500,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — please try again later' }
});
app.use('/api/', apiLimiter);

// Auth endpoints — tighter
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' } });
app.use('/api/auth/login', loginLimiter);

const superAdminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many attempts' } });
app.use('/api/auth/superadmin-login', superAdminLimiter);

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many registration attempts' } });
app.use('/api/auth/register', registerLimiter);

// Document uploads
const docUploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 50, message: { error: 'Too many document uploads' } });
app.use('/api/admin/documents', docUploadLimiter);

// Heavy operations — export/PDF/ZIP generation
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  message: { error: 'Too many export requests — please try again in an hour' }
});
app.use('/api/admin/records/export', exportLimiter);
app.use('/api/admin/projects/export', exportLimiter);
app.use('/api/admin/payroll/export', exportLimiter);
app.use('/api/admin/rest-days/export', exportLimiter);
app.use('/api/admin/rest-days/export-pdf', exportLimiter);

// Routes
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/admin',           require('./routes/admin'));
app.use('/api/admin',           require('./routes/payroll'));
app.use('/api/admin/invoices',   require('./routes/invoices'));
app.use('/api/admin/documents',  require('./routes/documents'));
app.use('/api/employee',   require('./routes/employee'));
app.use('/api/superadmin', require('./routes/superadmin'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler — never expose internal details to clients
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

initDb()
  .then(() => {
    initCron();
    app.listen(PORT, () => {
      console.log(`WorkTrack running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
