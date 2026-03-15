const router = require('express').Router();
const bcrypt = require('bcryptjs');
const https  = require('https');
const http   = require('http');
const XLSX   = require('xlsx');
const archiver = require('archiver');
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

function buildRecordsQuery(query) {
  const { date, employee_id, store_id } = query;
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
  if (date)        { sql += ' AND wr.date = ?';      params.push(date); }
  if (employee_id) { sql += ' AND wr.user_id = ?';   params.push(employee_id); }
  if (store_id)    { sql += ' AND wr.store_id = ?';  params.push(store_id); }
  sql += ' GROUP BY wr.id ORDER BY wr.date DESC, wr.clock_in DESC';
  return { sql, params };
}

function calcDurationMins(clockIn, clockOut) {
  if (!clockIn || !clockOut) return null;
  return Math.round((new Date(clockOut) - new Date(clockIn)) / 60000);
}

function formatDuration(mins) {
  if (mins === null) return '';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

router.get('/records', (req, res) => {
  const { sql, params } = buildRecordsQuery(req.query);
  res.json(db.prepare(sql).all(...params));
});

// ─── Export Records ───────────────────────────────────────────────────────────

router.get('/records/export', (req, res) => {
  const { format = 'csv' } = req.query;
  const { sql, params } = buildRecordsQuery(req.query);
  const records = db.prepare(sql).all(...params);

  const rows = records.map(r => {
    const mins = calcDurationMins(r.clock_in, r.clock_out);
    return {
      Employee: r.employee,
      Store:    r.store,
      Address:  r.address,
      Date:     r.date,
      'Clock In':  r.clock_in  ? new Date(r.clock_in).toLocaleString()  : '',
      'Clock Out': r.clock_out ? new Date(r.clock_out).toLocaleString() : 'In progress',
      'Duration':  formatDuration(mins),
      'Notes':     r.notes || '',
      'Media Files': r.media_count
    };
  });

  if (format === 'excel') {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Records');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="records.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  // Default: CSV
  const cols = Object.keys(rows[0] || {});
  const csvEscape = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [
    cols.map(csvEscape).join(','),
    ...rows.map(r => cols.map(c => csvEscape(r[c])).join(','))
  ].join('\r\n');

  res.setHeader('Content-Disposition', 'attachment; filename="records.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
});

// ─── Media ────────────────────────────────────────────────────────────────────

router.get('/records/:id/media', (req, res) => {
  const media = db.prepare(
    'SELECT * FROM media WHERE record_id = ? ORDER BY type, uploaded_at'
  ).all(req.params.id);
  res.json(media);
});

// ─── Download Evidence (zip) ──────────────────────────────────────────────────

function fetchFileBuffer(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    lib.get(urlStr, (response) => {
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} for ${urlStr}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

router.get('/records/:id/media/download', async (req, res) => {
  const record = db.prepare(`
    SELECT wr.id, u.name as employee, wr.date
    FROM work_records wr JOIN users u ON u.id = wr.user_id
    WHERE wr.id = ?
  `).get(req.params.id);

  if (!record) return res.status(404).json({ error: 'Record not found' });

  const media = db.prepare(
    'SELECT * FROM media WHERE record_id = ? ORDER BY type, uploaded_at'
  ).all(req.params.id);

  if (!media.length) return res.status(404).json({ error: 'No media for this record' });

  const safeName = record.employee.replace(/[^a-z0-9]/gi, '_');
  const filename = `evidence_${safeName}_${record.date}.zip`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', err => { console.error('Archive error:', err); });
  archive.pipe(res);

  for (const m of media) {
    try {
      const fileUrl = m.url || null;
      if (!fileUrl) continue; // skip legacy local files without URL
      const buf = await fetchFileBuffer(fileUrl);
      const ext = m.original_name.includes('.') ? m.original_name.split('.').pop() : 'bin';
      const entryName = `${m.type}/${m.id}_${m.original_name}`;
      archive.append(buf, { name: entryName });
    } catch (err) {
      console.error(`Failed to fetch media ${m.id}:`, err.message);
    }
  }

  await archive.finalize();
});

module.exports = router;
