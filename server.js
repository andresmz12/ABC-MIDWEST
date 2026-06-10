require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./database');
const { initCron } = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers (CSP disabled — app uses inline scripts throughout)
app.use(helmet({ contentSecurityPolicy: false }));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rate limiting on login
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' } });
app.use('/api/auth/login', loginLimiter);

const superAdminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many attempts' } });
app.use('/api/auth/superadmin-login', superAdminLimiter);

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many registration attempts' } });
app.use('/api/auth/register', registerLimiter);

// Routes
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/admin',      require('./routes/admin'));
app.use('/api/admin',      require('./routes/payroll'));
app.use('/api/employee',   require('./routes/employee'));
app.use('/api/superadmin', require('./routes/superadmin'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
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
