const jwt = require('jsonwebtoken');
const { query } = require('../database');

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET must be set in production. Exiting.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET not set. Using insecure fallback — set JWT_SECRET in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'worktrack-secret-change-me';

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Tokens issued before the multi-tenant migration won't have company_id
  if (payload.company_id == null && payload.role !== 'super_admin') {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  try {
    const { rows } = await query('SELECT force_logout FROM users WHERE id = $1', [payload.id]);
    if (!rows.length || rows[0].force_logout) {
      return res.status(401).json({ error: 'Session terminated by administrator. Please log in again.' });
    }
  } catch (dbErr) {
    // DB hiccup — don't destroy the session, let the request fail gracefully
    console.error('[Auth] DB error during token check:', dbErr.message);
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
  }

  req.user = payload;
  req.companyId = payload.company_id ?? null;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!req.companyId) {
      return res.status(403).json({ error: 'Company context required' });
    }
    next();
  });
}

async function requireSuperAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  });
}

// Validates that :id route param is a positive integer — prevents invalid DB queries
function requireNumericId(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  req.params.id = String(id);
  next();
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, JWT_SECRET, requireNumericId };
