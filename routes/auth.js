const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

// Computed once at startup — keeps response time constant when user not found (prevents username enumeration)
const DUMMY_HASH = bcrypt.hashSync('__worktrack_dummy_sentinel__', 10);

// ── Login ──────────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Look up user by username across all active companies (super_admin excluded)
    const { rows } = await query(
      `SELECT u.* FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.username = $1 AND u.role != 'super_admin' AND c.active = TRUE`,
      [username]
    );

    // If the same username exists in more than one company the admin must fix it
    if (rows.length > 1) {
      return res.status(401).json({ error: 'Duplicate username across workspaces — contact your administrator' });
    }

    const user = rows[0];

    // Always run bcrypt to prevent username enumeration via timing
    const hashToCheck = user ? user.password : DUMMY_HASH;
    if (!bcrypt.compareSync(password, hashToCheck) || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await query('UPDATE users SET force_logout = FALSE WHERE id = $1', [user.id]);

    const token = jwt.sign(
      {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        company_id: user.company_id ?? null
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        company_id: user.company_id ?? null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Register new company + admin ───────────────────────────────────────────────

router.post('/register', async (req, res) => {
  try {
    const { company_name, company_slug, timezone, admin_name, admin_username, admin_password, admin_email } = req.body;

    if (!company_name || !company_slug || !admin_name || !admin_username || !admin_password) {
      return res.status(400).json({ error: 'company_name, company_slug, admin_name, admin_username and admin_password are required' });
    }

    if (admin_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const slug = company_slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
      return res.status(400).json({ error: 'Invalid slug format. Use lowercase letters, numbers and hyphens (3-50 chars).' });
    }

    const { rows: existingSlug } = await query('SELECT id FROM companies WHERE slug = $1', [slug]);
    if (existingSlug.length) {
      return res.status(400).json({ error: 'Company slug already taken' });
    }

    const tz = timezone || 'America/Chicago';

    const { id: companyId } = await query(
      `INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, $3) RETURNING id`,
      [company_name.trim(), slug, tz]
    ).then(r => r.rows[0]);

    // Seed default notification settings for the new company
    await query(`
      INSERT INTO notification_settings (company_id, key, value) VALUES
        ($1, 'time_night',   '20:00'),
        ($1, 'time_morning', '08:00'),
        ($1, 'time_midday',  '12:00')
      ON CONFLICT (company_id, key) DO NOTHING
    `, [companyId]);

    // Check username uniqueness within this company
    const { rows: existingUser } = await query(
      'SELECT id FROM users WHERE username = $1 AND company_id = $2',
      [admin_username, companyId]
    );
    if (existingUser.length) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const hash = bcrypt.hashSync(admin_password, 10);
    await query(
      `INSERT INTO users (company_id, name, username, password, role, email) VALUES ($1, $2, $3, $4, 'admin', $5)`,
      [companyId, admin_name.trim(), admin_username.trim(), hash, admin_email?.trim() || null]
    );

    res.status(201).json({ success: true, company_slug: slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Super admin login (isolated endpoint) ─────────────────────────────────────

router.post('/superadmin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { rows } = await query(
      `SELECT * FROM users WHERE username = $1 AND role = 'super_admin'`,
      [username]
    );
    const user = rows[0];

    // Always run bcrypt to prevent username enumeration via timing
    const saHashToCheck = user ? user.password : DUMMY_HASH;
    if (!bcrypt.compareSync(password, saHashToCheck) || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await query('UPDATE users SET force_logout = FALSE WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { id: user.id, name: user.name, username: user.username, role: user.role, company_id: null },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role, company_id: null }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: company count only — used to decide login UI mode (never reveals names) ──

router.get('/companies/count', async (req, res) => {
  try {
    const { rows } = await query(`SELECT COUNT(*) AS total FROM companies WHERE active = TRUE`);
    res.json({ total: parseInt(rows[0].total, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: default company slug — only works when exactly 1 company exists ───

router.get('/companies/default', async (req, res) => {
  try {
    const { rows } = await query(`SELECT slug FROM companies WHERE active = TRUE`);
    if (rows.length !== 1) return res.status(404).json({ error: 'Not a single-company instance' });
    res.json({ slug: rows[0].slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: get company info by slug (for login page branding) ─────────────────

router.get('/company-info', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const { rows } = await query(
      `SELECT name, logo_url FROM companies WHERE slug = $1 AND active = TRUE`,
      [slug.trim().toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
