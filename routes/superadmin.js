const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../database');
const { requireSuperAdmin } = require('../middleware/auth');

router.use(requireSuperAdmin);

// ── List all companies ─────────────────────────────────────────────────────────

router.get('/companies', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'admin')::int   AS admin_count,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'employee')::int AS employee_count
      FROM companies c
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Get single company ─────────────────────────────────────────────────────────

router.get('/companies/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Create company (with initial admin) ───────────────────────────────────────

router.post('/companies', async (req, res) => {
  try {
    const { name, slug, timezone, admin_name, admin_username, admin_password, admin_email } = req.body;
    if (!name || !slug || !admin_name || !admin_username || !admin_password) {
      return res.status(400).json({ error: 'name, slug, admin_name, admin_username and admin_password required' });
    }

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(cleanSlug)) {
      return res.status(400).json({ error: 'Invalid slug. Use lowercase letters, numbers and hyphens (3-50 chars).' });
    }

    const { rows: existing } = await query('SELECT id FROM companies WHERE slug = $1', [cleanSlug]);
    if (existing.length) return res.status(400).json({ error: 'Slug already taken' });

    const tz = timezone || 'America/Chicago';

    const result = await withTransaction(async client => {
      const { rows: co } = await client.query(
        `INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, $3) RETURNING id`,
        [name.trim(), cleanSlug, tz]
      );
      const companyId = co[0].id;

      await client.query(`
        INSERT INTO notification_settings (company_id, key, value) VALUES
          ($1, 'time_night',   '20:00'),
          ($1, 'time_morning', '08:00'),
          ($1, 'time_midday',  '12:00')
        ON CONFLICT (company_id, key) DO NOTHING
      `, [companyId]);

      const hash = bcrypt.hashSync(admin_password, 10);
      await client.query(
        `INSERT INTO users (company_id, name, username, password, role, email) VALUES ($1, $2, $3, $4, 'admin', $5)`,
        [companyId, admin_name.trim(), admin_username.trim(), hash, admin_email?.trim() || null]
      );

      return companyId;
    });

    res.status(201).json({ id: result, slug: cleanSlug });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Update company ─────────────────────────────────────────────────────────────

router.put('/companies/:id', async (req, res) => {
  try {
    const { name, slug, timezone, logo_url, active } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const { rows: existing } = await query(
      'SELECT id FROM companies WHERE slug = $1 AND id != $2',
      [cleanSlug, req.params.id]
    );
    if (existing.length) return res.status(400).json({ error: 'Slug already taken' });

    await query(
      `UPDATE companies SET name = $1, slug = $2, timezone = $3, logo_url = $4, active = $5 WHERE id = $6`,
      [name.trim(), cleanSlug, timezone || 'America/Chicago', logo_url || null, active !== false, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Delete (deactivate) company ────────────────────────────────────────────────

router.delete('/companies/:id', async (req, res) => {
  try {
    await query(`UPDATE companies SET active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Global stats ───────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const [coRes, userRes, recordRes] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active FROM companies`),
      query(`SELECT COUNT(*) FILTER (WHERE role = 'admin')::int AS admins, COUNT(*) FILTER (WHERE role = 'employee')::int AS employees FROM users WHERE company_id IS NOT NULL`),
      query(`SELECT COUNT(*)::int AS total FROM work_records`)
    ]);
    res.json({
      companies: coRes.rows[0],
      users: userRes.rows[0],
      work_records: recordRes.rows[0].total
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
