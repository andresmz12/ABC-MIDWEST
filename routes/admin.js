const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');

// All admin routes require admin role
router.use(requireAdmin);

// ─── Employees ────────────────────────────────────────────────────────────────

router.get('/employees', (req, res) => {
  const employees = db.prepare(
    "SELECT id, name, username, created_at FROM users WHERE role = 'employee' ORDER BY name"
  ).all();
  res.json(employees);
});

router.post('/employees', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username and password required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (name, username, password, role) VALUES (?, ?, ?, ?)'
  ).run(name, username, hash, 'employee');

  res.status(201).json({ id: result.lastInsertRowid, name, username });
});

router.delete('/employees/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ? AND role = ?').run(req.params.id, 'employee');
  res.json({ success: true });
});

// ─── Stores ───────────────────────────────────────────────────────────────────

router.get('/stores', (req, res) => {
  const stores = db.prepare('SELECT * FROM stores ORDER BY name').all();
  res.json(stores);
});

router.post('/stores', (req, res) => {
  const { name, address } = req.body;
  if (!name || !address) return res.status(400).json({ error: 'Name and address required' });

  const result = db.prepare(
    'INSERT INTO stores (name, address) VALUES (?, ?)'
  ).run(name, address);

  res.status(201).json({ id: result.lastInsertRowid, name, address });
});

router.put('/stores/:id', (req, res) => {
  const { name, address } = req.body;
  if (!name || !address) return res.status(400).json({ error: 'Name and address required' });

  db.prepare('UPDATE stores SET name = ?, address = ? WHERE id = ?')
    .run(name, address, req.params.id);
  res.json({ success: true });
});

router.delete('/stores/:id', (req, res) => {
  db.prepare('DELETE FROM stores WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Records ──────────────────────────────────────────────────────────────────

router.get('/records', (req, res) => {
  const { date, employee_id, store_id } = req.query;
  let sql = `
    SELECT wr.id, u.name as employee, s.name as store, s.address,
           wr.date, wr.clock_in, wr.clock_out, wr.notes,
           COUNT(m.id) as media_count
    FROM work_records wr
    JOIN users u ON u.id = wr.user_id
    JOIN stores s ON s.id = wr.store_id
    LEFT JOIN media m ON m.record_id = wr.id
    WHERE 1=1
  `;
  const params = [];

  if (date) { sql += ' AND wr.date = ?'; params.push(date); }
  if (employee_id) { sql += ' AND wr.user_id = ?'; params.push(employee_id); }
  if (store_id) { sql += ' AND wr.store_id = ?'; params.push(store_id); }

  sql += ' GROUP BY wr.id ORDER BY wr.date DESC, wr.clock_in DESC';

  res.json(db.prepare(sql).all(...params));
});

router.get('/records/:id/media', (req, res) => {
  const media = db.prepare(
    'SELECT * FROM media WHERE record_id = ? ORDER BY type, uploaded_at'
  ).all(req.params.id);
  res.json(media);
});

module.exports = router;
