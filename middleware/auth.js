const jwt = require('jsonwebtoken');
const { query } = require('../database');
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set via environment variable. Using insecure fallback — set JWT_SECRET in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'abc-midwest-secret-2024';

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await query('SELECT force_logout FROM users WHERE id = $1', [payload.id]);
    if (!rows.length || rows[0].force_logout) {
      return res.status(401).json({ error: 'Session terminated by administrator. Please log in again.' });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
