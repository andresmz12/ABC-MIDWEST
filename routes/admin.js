const router = require('express').Router();
const bcrypt = require('bcryptjs');
const https  = require('https');
const http   = require('http');
const ExcelJS = require('exceljs');
const archiver = require('archiver');
const multer = require('multer');
const { query, withTransaction } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All admin routes require admin role
router.use(requireAdmin);

// ─── Employees ────────────────────────────────────────────────────────────────

router.get('/employees', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.name, u.username, u.created_at,
             COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '[]') as stores
      FROM users u
      LEFT JOIN user_stores us ON us.user_id = u.id
      LEFT JOIN stores s ON s.id = us.store_id
      WHERE u.role = 'employee'
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/employees', async (req, res) => {
  try {
    const { name, username, password, store_ids } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Name, username and password required' });
    }
    if (!store_ids || !Array.isArray(store_ids) || store_ids.length === 0) {
      return res.status(400).json({ error: 'At least one store must be assigned' });
    }
    const { rows: existing } = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.length) return res.status(400).json({ error: 'Username already taken' });

    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await query(
      'INSERT INTO users (name, username, password, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, username, hash, 'employee']
    );
    const userId = rows[0].id;
    for (const storeId of store_ids) {
      await query('INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)', [userId, storeId]);
    }
    res.status(201).json({ id: userId, name, username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/employees/:id', async (req, res) => {
  try {
    await query("DELETE FROM users WHERE id = $1 AND role = 'employee'", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/employees/:id/force-logout', async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM users WHERE id = $1 AND role = 'employee'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    await query('UPDATE users SET force_logout = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/employees/:id', async (req, res) => {
  try {
    const { name, username, password, store_ids } = req.body;
    if (!name || !username) return res.status(400).json({ error: 'Name and username required' });
    if (!store_ids || !Array.isArray(store_ids) || store_ids.length === 0) {
      return res.status(400).json({ error: 'At least one store must be assigned' });
    }
    const { rows: existing } = await query(
      'SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.params.id]
    );
    if (existing.length) return res.status(400).json({ error: 'Username already taken' });

    await withTransaction(async client => {
      if (password) {
        const hash = bcrypt.hashSync(password, 10);
        await client.query('UPDATE users SET name = $1, username = $2, password = $3 WHERE id = $4 AND role = $5',
          [name, username, hash, req.params.id, 'employee']);
      } else {
        await client.query('UPDATE users SET name = $1, username = $2 WHERE id = $3 AND role = $4',
          [name, username, req.params.id, 'employee']);
      }
      await client.query('DELETE FROM user_stores WHERE user_id = $1', [req.params.id]);
      for (const storeId of store_ids) {
        await client.query('INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)', [req.params.id, storeId]);
      }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Stores ───────────────────────────────────────────────────────────────────

router.get('/stores', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM stores ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/stores', async (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name || !address) return res.status(400).json({ error: 'Name and address required' });
    const { rows } = await query(
      'INSERT INTO stores (name, address) VALUES ($1, $2) RETURNING id',
      [name, address]
    );
    res.status(201).json({ id: rows[0].id, name, address });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Import Employees from Excel ──────────────────────────────────────────────
// Excel format: columns Name, Username, Password
router.post('/employees/import', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Empty or invalid Excel file' });

    const rows = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      const name     = String(row.getCell(1).value ?? '').trim();
      const username = String(row.getCell(2).value ?? '').trim();
      const password = String(row.getCell(3).value ?? '').trim();
      if (name && username && password) rows.push({ name, username, password });
    });

    if (!rows.length) return res.json({ imported: 0, errors: [] });

    let imported = 0;
    const errors = [];
    for (const emp of rows) {
      try {
        const { rows: existing } = await query('SELECT id FROM users WHERE username = $1', [emp.username]);
        if (existing.length) { errors.push(`"${emp.username}": username already taken`); continue; }
        const hash = bcrypt.hashSync(emp.password, 10);
        await query('INSERT INTO users (name, username, password, role) VALUES ($1, $2, $3, $4)',
          [emp.name, emp.username, hash, 'employee']);
        imported++;
      } catch (err) {
        errors.push(`"${emp.username}": ${err.message}`);
      }
    }
    res.json({ imported, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Import Stores from Excel ─────────────────────────────────────────────────
// Excel format: single column with header "Store Number"
router.post('/stores/import', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Empty or invalid Excel file' });

    const names = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header row
      const val = String(row.getCell(1).value ?? '').trim();
      if (val) names.push(val);
    });

    if (!names.length) return res.json({ imported: 0, errors: [] });

    let imported = 0;
    const errors = [];
    for (const name of names) {
      try {
        await query('INSERT INTO stores (name, address) VALUES ($1, $2)', [name, '']);
        imported++;
      } catch (err) {
        errors.push(`"${name}": ${err.message}`);
      }
    }
    res.json({ imported, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/stores/:id', async (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name || !address) return res.status(400).json({ error: 'Name and address required' });
    await query('UPDATE stores SET name = $1, address = $2 WHERE id = $3', [name, address, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/stores/:id', async (req, res) => {
  try {
    await query('DELETE FROM stores WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Records ──────────────────────────────────────────────────────────────────

function buildRecordsQuery(reqQuery) {
  const { date_from, date_to, employee_id, store_id } = reqQuery;
  let sql = `
    SELECT wr.id, u.name as employee, s.name as store, s.address,
           wr.date, wr.clock_in, wr.clock_out, wr.notes,
           wr.clock_in_lat, wr.clock_in_lng, wr.clock_out_lat, wr.clock_out_lng,
           wr.clock_in_address, wr.clock_out_address,
           COUNT(m.id) as media_count
    FROM work_records wr
    JOIN users u ON u.id = wr.user_id
    JOIN stores s ON s.id = wr.store_id
    LEFT JOIN media m ON m.record_id = wr.id
    WHERE 1=1
  `;
  const params = [];
  let i = 1;
  if (date_from)   { sql += ` AND wr.date >= $${i++}`;    params.push(date_from); }
  if (date_to)     { sql += ` AND wr.date <= $${i++}`;    params.push(date_to); }
  if (employee_id) { sql += ` AND wr.user_id = $${i++}`;  params.push(employee_id); }
  if (store_id)    { sql += ` AND wr.store_id = $${i++}`; params.push(store_id); }
  sql += ' GROUP BY wr.id, u.name, s.name, s.address, wr.clock_in_address, wr.clock_out_address ORDER BY wr.date DESC, wr.clock_in DESC';
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

router.get('/records', async (req, res) => {
  try {
    const { sql, params } = buildRecordsQuery(req.query);
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Export Records ───────────────────────────────────────────────────────────

router.get('/records/export', async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const { sql, params } = buildRecordsQuery(req.query);
    const { rows: records } = await query(sql, params);

    const rows = records.map(r => {
      const mins = calcDurationMins(r.clock_in, r.clock_out);
      return {
        Employee: r.employee,
        Store:    r.store,
        Address:  r.address,
        Date:     r.date,
        'Clock In':          r.clock_in  ? new Date(r.clock_in).toLocaleString()  : '',
        'Clock-In Address':  r.clock_in_address  || '',
        'Clock Out':         r.clock_out ? new Date(r.clock_out).toLocaleString() : 'In progress',
        'Clock-Out Address': r.clock_out_address || '',
        'Duration':          formatDuration(mins),
        'Notes':             r.notes || '',
        'Media Files':       r.media_count
      };
    });

    if (format === 'excel') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Records');
      if (rows.length > 0) {
        ws.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: 20 }));
        rows.forEach(r => ws.addRow(r));
        ws.getRow(1).font = { bold: true };
      }
      res.setHeader('Content-Disposition', 'attachment; filename="records.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const buf = await wb.xlsx.writeBuffer();
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Extra Projects ───────────────────────────────────────────────────────────

function buildProjectsQuery(reqQuery) {
  const { date_from, date_to, employee_id } = reqQuery;
  let sql = `
    SELECT wr.id, u.name as employee, wr.project_name,
           wr.date, wr.clock_in, wr.clock_out, wr.notes,
           wr.clock_in_lat, wr.clock_in_lng, wr.clock_out_lat, wr.clock_out_lng,
           wr.clock_in_address, wr.clock_out_address,
           COUNT(m.id) as media_count
    FROM work_records wr
    JOIN users u ON u.id = wr.user_id
    LEFT JOIN media m ON m.record_id = wr.id
    WHERE wr.project_name IS NOT NULL
  `;
  const params = [];
  let i = 1;
  if (date_from)   { sql += ` AND wr.date >= $${i++}`;   params.push(date_from); }
  if (date_to)     { sql += ` AND wr.date <= $${i++}`;   params.push(date_to); }
  if (employee_id) { sql += ` AND wr.user_id = $${i++}`; params.push(employee_id); }
  sql += ' GROUP BY wr.id, u.name, wr.clock_in_address, wr.clock_out_address ORDER BY wr.date DESC, wr.clock_in DESC';
  return { sql, params };
}

router.get('/projects', async (req, res) => {
  try {
    const { sql, params } = buildProjectsQuery(req.query);
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/export', async (req, res) => {
  try {
    const { sql, params } = buildProjectsQuery(req.query);
    const { rows: records } = await query(sql, params);

    const rows = records.map(r => {
      const mins = calcDurationMins(r.clock_in, r.clock_out);
      return {
        Employee:            r.employee,
        Project:             r.project_name,
        Date:                r.date,
        'Clock In':          r.clock_in  ? new Date(r.clock_in).toLocaleString()  : '',
        'Clock-In Address':  r.clock_in_address  || '',
        'Clock Out':         r.clock_out ? new Date(r.clock_out).toLocaleString() : 'In progress',
        'Clock-Out Address': r.clock_out_address || '',
        Duration:            formatDuration(mins),
        Notes:               r.notes || '',
        'Media Files':       Number(r.media_count)
      };
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Extra Projects');
    if (rows.length > 0) {
      ws.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: 22 }));
      rows.forEach(r => ws.addRow(r));
      ws.getRow(1).font = { bold: true };
    }
    res.setHeader('Content-Disposition', 'attachment; filename="extra_projects.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const buf = await wb.xlsx.writeBuffer();
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Media ────────────────────────────────────────────────────────────────────

router.post('/records/:id/force-clock-out', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM work_records WHERE id = $1 AND clock_out IS NULL',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Active record not found' });
    const clockOut = new Date().toISOString();
    await query(
      "UPDATE work_records SET clock_out = $1, notes = COALESCE(NULLIF(notes,''), '') || CASE WHEN notes IS NOT NULL AND notes <> '' THEN ' | ' ELSE '' END || '[Forced clock-out by admin]' WHERE id = $2",
      [clockOut, req.params.id]
    );
    res.json({ success: true, clock_out: clockOut });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/records/:id/media', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM media WHERE record_id = $1 ORDER BY type, uploaded_at',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  try {
    const { rows: recs } = await query(
      'SELECT wr.id, u.name as employee, wr.date FROM work_records wr JOIN users u ON u.id = wr.user_id WHERE wr.id = $1',
      [req.params.id]
    );
    const record = recs[0];
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const { rows: media } = await query(
      'SELECT * FROM media WHERE record_id = $1 ORDER BY type, uploaded_at',
      [req.params.id]
    );
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
        if (!m.url) continue;
        const buf = await fetchFileBuffer(m.url);
        archive.append(buf, { name: `${m.type}/${m.id}_${m.original_name}` });
      } catch (err) {
        console.error(`Failed to fetch media ${m.id}:`, err.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
