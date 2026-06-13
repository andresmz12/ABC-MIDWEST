const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const bcrypt = require('bcryptjs');
const https  = require('https');
const http   = require('http');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const multer = require('multer');
const { query, withTransaction } = require('../database');
const { requireAdmin } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All admin routes require admin role
router.use(requireAdmin);

// ── Company info (for frontend branding) ──────────────────────────────────────

router.get('/company', async (req, res) => {
  try {
    const { rows } = await query('SELECT id, name, slug, logo_url, timezone FROM companies WHERE id = $1', [req.companyId]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Employees ────────────────────────────────────────────────────────────────

router.get('/employees', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.name, u.username, u.email, u.created_at,
             COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '[]') as stores
      FROM users u
      LEFT JOIN user_stores us ON us.user_id = u.id
      LEFT JOIN stores s ON s.id = us.store_id
      WHERE u.role = 'employee' AND u.company_id = $1
      GROUP BY u.id
      ORDER BY u.name
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/employees', async (req, res) => {
  try {
    const { name, username, password, email, store_ids } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Name, username and password required' });
    }
    if (!store_ids || !Array.isArray(store_ids) || store_ids.length === 0) {
      return res.status(400).json({ error: 'At least one store must be assigned' });
    }

    const { rows: existing } = await query(
      'SELECT id FROM users WHERE username = $1 AND company_id = $2',
      [username, req.companyId]
    );
    if (existing.length) return res.status(400).json({ error: 'Username already taken' });

    // Verify all stores belong to this company
    const { rows: validStores } = await query(
      `SELECT id FROM stores WHERE id = ANY($1) AND company_id = $2`,
      [store_ids, req.companyId]
    );
    if (validStores.length !== store_ids.length) {
      return res.status(400).json({ error: 'One or more stores not found' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await query(
      'INSERT INTO users (company_id, name, username, password, email, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.companyId, name, username, hash, email || null, 'employee']
    );
    const userId = rows[0].id;
    for (const storeId of store_ids) {
      await query('INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)', [userId, storeId]);
    }
    res.status(201).json({ id: userId, name, username, email: email || null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/employees/:id', async (req, res) => {
  try {
    await query(
      "DELETE FROM users WHERE id = $1 AND role = 'employee' AND company_id = $2",
      [req.params.id, req.companyId]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/employees/:id/force-logout', async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT id FROM users WHERE id = $1 AND role = 'employee' AND company_id = $2",
      [req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    await query('UPDATE users SET force_logout = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/employees/:id', async (req, res) => {
  try {
    const { name, username, password, email, store_ids } = req.body;
    if (!name || !username) return res.status(400).json({ error: 'Name and username required' });
    if (!store_ids || !Array.isArray(store_ids) || store_ids.length === 0) {
      return res.status(400).json({ error: 'At least one store must be assigned' });
    }

    const { rows: existing } = await query(
      'SELECT id FROM users WHERE username = $1 AND company_id = $2 AND id != $3',
      [username, req.companyId, req.params.id]
    );
    if (existing.length) return res.status(400).json({ error: 'Username already taken' });

    // Verify employee belongs to this company
    const { rows: empCheck } = await query(
      "SELECT id FROM users WHERE id = $1 AND company_id = $2 AND role = 'employee'",
      [req.params.id, req.companyId]
    );
    if (!empCheck.length) return res.status(404).json({ error: 'Employee not found' });

    // Verify stores belong to this company
    const { rows: validStores } = await query(
      `SELECT id FROM stores WHERE id = ANY($1) AND company_id = $2`,
      [store_ids, req.companyId]
    );
    if (validStores.length !== store_ids.length) {
      return res.status(400).json({ error: 'One or more stores not found' });
    }

    await withTransaction(async client => {
      if (password) {
        const hash = bcrypt.hashSync(password, 10);
        await client.query(
          "UPDATE users SET name = $1, username = $2, password = $3, email = $4 WHERE id = $5 AND role = 'employee' AND company_id = $6",
          [name, username, hash, email || null, req.params.id, req.companyId]
        );
      } else {
        await client.query(
          "UPDATE users SET name = $1, username = $2, email = $3 WHERE id = $4 AND role = 'employee' AND company_id = $5",
          [name, username, email || null, req.params.id, req.companyId]
        );
      }
      await client.query('DELETE FROM user_stores WHERE user_id = $1', [req.params.id]);
      for (const storeId of store_ids) {
        await client.query('INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)', [req.params.id, storeId]);
      }
    });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Import Employees from Excel ──────────────────────────────────────────────

router.post('/employees/import', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Empty or invalid Excel file' });

    const rows = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
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
        const { rows: existing } = await query(
          'SELECT id FROM users WHERE username = $1 AND company_id = $2',
          [emp.username, req.companyId]
        );
        if (existing.length) { errors.push(`"${emp.username}": username already taken`); continue; }
        const hash = bcrypt.hashSync(emp.password, 10);
        await query(
          'INSERT INTO users (company_id, name, username, password, role) VALUES ($1, $2, $3, $4, $5)',
          [req.companyId, emp.name, emp.username, hash, 'employee']
        );
        imported++;
      } catch (err) {
        console.error(err);
        errors.push(`"${emp.username}": import failed`);
      }
    }
    res.json({ imported, errors });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Stores ───────────────────────────────────────────────────────────────────

router.get('/stores', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM stores WHERE company_id = $1 ORDER BY name', [req.companyId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/stores', async (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name || !address) return res.status(400).json({ error: 'Name and address required' });
    const { rows } = await query(
      'INSERT INTO stores (company_id, name, address) VALUES ($1, $2, $3) RETURNING id',
      [req.companyId, name, address]
    );
    res.status(201).json({ id: rows[0].id, name, address });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/stores/:id', async (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name || !address) return res.status(400).json({ error: 'Name and address required' });
    await query(
      'UPDATE stores SET name = $1, address = $2 WHERE id = $3 AND company_id = $4',
      [name, address, req.params.id, req.companyId]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/stores/:id', async (req, res) => {
  try {
    await query('DELETE FROM stores WHERE id = $1 AND company_id = $2', [req.params.id, req.companyId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Import Stores from Excel ─────────────────────────────────────────────────

router.post('/stores/import', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Empty or invalid Excel file' });

    const names = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const val = String(row.getCell(1).value ?? '').trim();
      if (val) names.push(val);
    });

    if (!names.length) return res.json({ imported: 0, errors: [] });

    let imported = 0;
    const errors = [];
    for (const name of names) {
      try {
        await query('INSERT INTO stores (company_id, name, address) VALUES ($1, $2, $3)', [req.companyId, name, '']);
        imported++;
      } catch (err) {
        console.error(err);
        errors.push(`"${name}": import failed`);
      }
    }
    res.json({ imported, errors });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Records ──────────────────────────────────────────────────────────────────

function buildRecordsQuery(companyId, reqQuery) {
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
    WHERE wr.company_id = $1
  `;
  const params = [companyId];
  let i = 2;
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
    const { sql, params } = buildRecordsQuery(req.companyId, req.query);
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Export Records ───────────────────────────────────────────────────────────

router.get('/records/export', async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const { sql, params } = buildRecordsQuery(req.companyId, req.query);
    const { rows: records } = await query(sql, params);

    const rows = records.map(r => {
      const mins = calcDurationMins(r.clock_in, r.clock_out);
      return {
        Employee:            r.employee,
        Store:               r.store,
        Address:             r.address,
        Date:                r.date,
        'Clock In':          r.clock_in  ? new Date(r.clock_in).toLocaleString()  : '',
        'Clock-In Address':  r.clock_in_address  || '',
        'Clock Out':         r.clock_out ? new Date(r.clock_out).toLocaleString() : 'In progress',
        'Clock-Out Address': r.clock_out_address || '',
        Duration:            formatDuration(mins),
        Notes:               r.notes || '',
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

    const cols = Object.keys(rows[0] || {});
    const csvEscape = v => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [
      cols.map(csvEscape).join(','),
      ...rows.map(r => cols.map(c => csvEscape(r[c])).join(','))
    ].join('\r\n');

    res.setHeader('Content-Disposition', 'attachment; filename="records.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('﻿' + csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Extra Projects ───────────────────────────────────────────────────────────

function buildProjectsQuery(companyId, reqQuery) {
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
    WHERE wr.project_name IS NOT NULL AND wr.company_id = $1
  `;
  const params = [companyId];
  let i = 2;
  if (date_from)   { sql += ` AND wr.date >= $${i++}`;   params.push(date_from); }
  if (date_to)     { sql += ` AND wr.date <= $${i++}`;   params.push(date_to); }
  if (employee_id) { sql += ` AND wr.user_id = $${i++}`; params.push(employee_id); }
  sql += ' GROUP BY wr.id, u.name, wr.clock_in_address, wr.clock_out_address ORDER BY wr.date DESC, wr.clock_in DESC';
  return { sql, params };
}

router.get('/projects', async (req, res) => {
  try {
    const { sql, params } = buildProjectsQuery(req.companyId, req.query);
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.get('/projects/export', async (req, res) => {
  try {
    const { sql, params } = buildProjectsQuery(req.companyId, req.query);
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
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Media ────────────────────────────────────────────────────────────────────

router.post('/records/:id/force-clock-out', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM work_records WHERE id = $1 AND clock_out IS NULL AND company_id = $2',
      [req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Active record not found' });
    const clockOut = new Date().toISOString();
    await query(
      "UPDATE work_records SET clock_out = $1, notes = COALESCE(NULLIF(notes,''), '') || CASE WHEN notes IS NOT NULL AND notes <> '' THEN ' | ' ELSE '' END || '[Forced clock-out by admin]' WHERE id = $2",
      [clockOut, req.params.id]
    );
    res.json({ success: true, clock_out: clockOut });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.get('/records/:id/media', async (req, res) => {
  try {
    // Verify record belongs to this company
    const { rows: rec } = await query(
      'SELECT id FROM work_records WHERE id = $1 AND company_id = $2',
      [req.params.id, req.companyId]
    );
    if (!rec.length) return res.status(404).json({ error: 'Record not found' });

    const { rows } = await query(
      'SELECT * FROM media WHERE record_id = $1 ORDER BY type, uploaded_at',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Download Evidence (zip) ──────────────────────────────────────────────────

function fetchFileBuffer(urlStr) {
  let parsedUrl;
  try { parsedUrl = new URL(urlStr); } catch { return Promise.reject(new Error('Invalid URL')); }
  if (!parsedUrl.hostname.endsWith('cloudinary.com') && !parsedUrl.hostname.endsWith('cloudinary.net')) {
    return Promise.reject(new Error('URL not allowed'));
  }
  return new Promise((resolve, reject) => {
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, (response) => {
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end',  () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

router.get('/records/:id/media/download', async (req, res) => {
  try {
    const { rows: recs } = await query(
      'SELECT wr.id, u.name as employee, wr.date FROM work_records wr JOIN users u ON u.id = wr.user_id WHERE wr.id = $1 AND wr.company_id = $2',
      [req.params.id, req.companyId]
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
    if (!res.headersSent) { console.error(err); res.status(500).json({ error: 'Server error' }); }
  }
});

// ─── Scheduled Jobs (Calendar) ────────────────────────────────────────────────

router.get('/scheduled-jobs', async (req, res) => {
  try {
    const { month } = req.query;
    let sql = 'SELECT * FROM scheduled_jobs WHERE company_id = $1';
    const params = [req.companyId];
    if (month) { sql += ' AND scheduled_date LIKE $2'; params.push(month + '%'); }
    sql += ' ORDER BY scheduled_date, id';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/scheduled-jobs', async (req, res) => {
  try {
    const { title, scheduled_date, assigned_to, location, notes, start_time, end_time } = req.body;
    if (!title || !scheduled_date) return res.status(400).json({ error: 'title and scheduled_date required' });
    const assignedArr = Array.isArray(assigned_to) ? assigned_to : [];
    const { rows } = await query(
      'INSERT INTO scheduled_jobs (company_id, title, scheduled_date, assigned_to, location, notes, start_time, end_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.companyId, title, scheduled_date, assignedArr, location || null, notes || null, start_time || null, end_time || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/scheduled-jobs/:id', async (req, res) => {
  try {
    const { title, scheduled_date, assigned_to, location, notes, start_time, end_time } = req.body;
    if (!title || !scheduled_date) return res.status(400).json({ error: 'title and scheduled_date required' });
    const assignedArr = Array.isArray(assigned_to) ? assigned_to : [];
    await query(
      'UPDATE scheduled_jobs SET title=$1, scheduled_date=$2, assigned_to=$3, location=$4, notes=$5, start_time=$6, end_time=$7 WHERE id=$8 AND company_id=$9',
      [title, scheduled_date, assignedArr, location || null, notes || null, start_time || null, end_time || null, req.params.id, req.companyId]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/scheduled-jobs/:id', async (req, res) => {
  try {
    await query('DELETE FROM scheduled_jobs WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/scheduled-jobs/:id/images', upload.array('images', 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No images uploaded' });
    // Verify job belongs to this company
    const { rows: jobCheck } = await query('SELECT id FROM scheduled_jobs WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    if (!jobCheck.length) return res.status(404).json({ error: 'Job not found' });

    const urls = req.files.map(f => f.path || f.secure_url || f.url || '').filter(Boolean);
    await query(
      'UPDATE scheduled_jobs SET image_urls = image_urls || $1 WHERE id=$2',
      [urls, req.params.id]
    );
    res.json({ urls });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/scheduled-jobs/:id/images', async (req, res) => {
  try {
    const { url } = req.body;
    await query(
      `UPDATE scheduled_jobs SET image_urls = array_remove(image_urls, $1) WHERE id=$2 AND company_id=$3`,
      [url, req.params.id, req.companyId]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Calendar Access ──────────────────────────────────────────────────────────

router.get('/calendar-access', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ca.user_id, u.name FROM calendar_access ca
       JOIN users u ON u.id = ca.user_id
       WHERE u.company_id = $1
       ORDER BY u.name`,
      [req.companyId]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/calendar-access', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    // Verify user belongs to this company
    const { rows } = await query('SELECT id FROM users WHERE id=$1 AND company_id=$2', [user_id, req.companyId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await query('INSERT INTO calendar_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user_id]);
    res.status(201).json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/calendar-access/:userId', async (req, res) => {
  try {
    // Verify user belongs to this company before revoking
    const { rows } = await query('SELECT id FROM users WHERE id=$1 AND company_id=$2', [req.params.userId, req.companyId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await query('DELETE FROM calendar_access WHERE user_id=$1', [req.params.userId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Rest Days ────────────────────────────────────────────────────────────────

router.get('/rest-days', async (req, res) => {
  try {
    const { month, employee_id } = req.query;
    let sql = `
      SELECT rd.*, u.name as employee_name,
             COALESCE(
               (SELECT json_agg(s.name ORDER BY s.name)
                FROM stores s WHERE s.id = ANY(rd.store_ids) AND s.company_id = $1), '[]'
             ) as store_names
      FROM rest_days rd
      JOIN users u ON u.id = rd.user_id
      WHERE rd.company_id = $1
    `;
    const params = [req.companyId];
    let i = 2;
    if (month)       { sql += ` AND rd.date LIKE $${i++}`; params.push(month + '%'); }
    if (employee_id) { sql += ` AND rd.user_id = $${i++}`; params.push(employee_id); }
    sql += ' ORDER BY rd.date DESC, u.name';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.get('/rest-days/export', async (req, res) => {
  try {
    const { month, employee_id } = req.query;
    let sql = `
      SELECT rd.date, u.name as employee,
             COALESCE(
               (SELECT string_agg(s.name, ', ' ORDER BY s.name)
                FROM stores s WHERE s.id = ANY(rd.store_ids) AND s.company_id = $1), ''
             ) as stores,
             rd.note
      FROM rest_days rd
      JOIN users u ON u.id = rd.user_id
      WHERE rd.company_id = $1
    `;
    const params = [req.companyId];
    let i = 2;
    if (month)       { sql += ` AND rd.date LIKE $${i++}`; params.push(month + '%'); }
    if (employee_id) { sql += ` AND rd.user_id = $${i++}`; params.push(employee_id); }
    sql += ' ORDER BY rd.date DESC, u.name';
    const { rows: records } = await query(sql, params);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rest Days');
    ws.columns = [
      { header: 'Employee', key: 'employee', width: 24 },
      { header: 'Date',     key: 'date',     width: 14 },
      { header: 'Stores',   key: 'stores',   width: 40 },
      { header: 'Note',     key: 'note',     width: 30 }
    ];
    records.forEach(r => ws.addRow({ employee: r.employee, date: r.date, stores: r.stores, note: r.note || '' }));
    ws.getRow(1).font = { bold: true };

    res.setHeader('Content-Disposition', 'attachment; filename="rest_days.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Rest Days PDF export ───────────────────────────────────────────────────────

router.get('/rest-days/export-pdf', async (req, res) => {
  try {
    const { month, employee_id } = req.query;

    // Get company name for PDF header
    const { rows: coRows } = await query('SELECT name FROM companies WHERE id = $1', [req.companyId]);
    const companyName = coRows[0]?.name || 'Company';

    let sql = `
      SELECT u.name as employee, rd.date, rd.note,
             COALESCE(
               (SELECT string_agg(s.name, ', ' ORDER BY s.name)
                FROM stores s WHERE s.id = ANY(rd.store_ids) AND s.company_id = $1), ''
             ) as stores
      FROM rest_days rd
      JOIN users u ON u.id = rd.user_id
      WHERE rd.company_id = $1
    `;
    const params = [req.companyId];
    let i = 2;
    if (month)       { sql += ` AND rd.date LIKE $${i++}`; params.push(month + '%'); }
    if (employee_id) { sql += ` AND rd.user_id = $${i++}`; params.push(employee_id); }
    sql += ' ORDER BY u.name, rd.date';
    const { rows } = await query(sql, params);

    const doc = new PDFDocument({ margin: 40, size: 'LETTER', compress: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rest_days${month ? '_' + month : ''}.pdf"`);
    doc.pipe(res);

    const blue = '#1a56db'; const dark = '#111827'; const muted = '#6b7280';
    const L = 40; const R = doc.page.width - 40; const W = R - L;

    // Header
    doc.rect(L, 40, W, 50).fill(blue);
    const logoPath = path.join(__dirname, '..', 'public', 'images', 'logo.png');
    let logoEndX = L + 10;
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, L + 8, 46, { height: 38, fit: [38, 38] }); logoEndX = L + 54; } catch (_) {}
    }
    doc.fillColor('#fff').fontSize(14).font('Helvetica-Bold').text(escTxt(companyName), logoEndX, 50, { width: 200 });
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.8)').text('Employee Rest Days Report', logoEndX, 67);
    if (month) {
      doc.fillColor('#fff').fontSize(9).font('Helvetica').text('Period: ' + month, L, 52, { align: 'right', width: W });
    }

    let y = 108;
    const byEmp = {};
    rows.forEach(r => { if (!byEmp[r.employee]) byEmp[r.employee] = []; byEmp[r.employee].push(r); });

    const colW = [W * 0.2, W * 0.18, W * 0.37, W * 0.25];
    const colX = [L, L + colW[0], L + colW[0] + colW[1], L + colW[0] + colW[1] + colW[2]];

    const drawHeader = (yy) => {
      doc.rect(L, yy, W, 18).fill(dark);
      doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
      ['Employee', 'Date', 'Stores', 'Note'].forEach((h, i) => {
        doc.text(h, colX[i] + 4, yy + 5, { width: colW[i] - 8 });
      });
      return yy + 18;
    };

    y = drawHeader(y);
    let rowIdx = 0;
    Object.entries(byEmp).forEach(([, records]) => {
      records.forEach(r => {
        if (y > doc.page.height - 80) { doc.addPage(); y = 40; y = drawHeader(y); rowIdx = 0; }
        if (rowIdx % 2 === 0) doc.rect(L, y, W, 16).fill('#f3f4f6');
        doc.fillColor(dark).fontSize(8).font('Helvetica');
        doc.text(escTxt(r.employee), colX[0] + 4, y + 4, { width: colW[0] - 8 });
        doc.text(r.date,             colX[1] + 4, y + 4, { width: colW[1] - 8 });
        doc.text(r.stores || '–',    colX[2] + 4, y + 4, { width: colW[2] - 8 });
        doc.text(r.note   || '–',    colX[3] + 4, y + 4, { width: colW[3] - 8 });
        y += 16; rowIdx++;
      });
    });

    doc.fillColor(muted).fontSize(8).font('Helvetica').text(`Total records: ${rows.length}`, L, y + 12);
    doc.end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
    const defaultFrom = `${y}-${m}-01`;
    const lastDay = new Date(y, now.getMonth() + 1, 0);
    const defaultTo = lastDay.toISOString().slice(0, 10);

    const dateFrom = req.query.date_from || defaultFrom;
    const dateTo   = req.query.date_to   || defaultTo;

    const [summaryRes, empRes, storeRes] = await Promise.all([
      query(`
        SELECT
          COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (wr.clock_out - wr.clock_in)) / 3600)::numeric, 2), 0) AS total_hours,
          COUNT(DISTINCT wr.user_id) AS active_employees
        FROM work_records wr
        WHERE wr.clock_out IS NOT NULL
          AND wr.company_id = $1
          AND wr.date >= $2 AND wr.date <= $3
      `, [req.companyId, dateFrom, dateTo]),

      query(`
        SELECT u.name,
               ROUND(SUM(EXTRACT(EPOCH FROM (wr.clock_out - wr.clock_in)) / 3600)::numeric, 2) AS hours
        FROM work_records wr
        JOIN users u ON u.id = wr.user_id
        WHERE wr.clock_out IS NOT NULL
          AND wr.company_id = $1
          AND wr.date >= $2 AND wr.date <= $3
        GROUP BY u.name
        ORDER BY hours DESC
      `, [req.companyId, dateFrom, dateTo]),

      query(`
        SELECT COALESCE(s.name, 'No Store') AS name,
               ROUND(SUM(EXTRACT(EPOCH FROM (wr.clock_out - wr.clock_in)) / 3600)::numeric, 2) AS hours
        FROM work_records wr
        LEFT JOIN stores s ON s.id = wr.store_id
        WHERE wr.clock_out IS NOT NULL
          AND wr.company_id = $1
          AND wr.date >= $2 AND wr.date <= $3
        GROUP BY s.name
        ORDER BY hours DESC
      `, [req.companyId, dateFrom, dateTo])
    ]);

    const summary = summaryRes.rows[0];
    res.json({
      totalHours:       parseFloat(summary.total_hours),
      activeEmployees:  parseInt(summary.active_employees, 10),
      topEmployee:      empRes.rows[0]   ? { name: empRes.rows[0].name,   hours: parseFloat(empRes.rows[0].hours)   } : null,
      topStore:         storeRes.rows[0] ? { name: storeRes.rows[0].name, hours: parseFloat(storeRes.rows[0].hours) } : null,
      hoursPerEmployee: empRes.rows.map(r   => ({ name: r.name, hours: parseFloat(r.hours) })),
      hoursByStore:     storeRes.rows.map(r => ({ name: r.name, hours: parseFloat(r.hours) })),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

function escTxt(s) { return (s || '').replace(/[^\x20-\x7E]/g, '?'); }

// ─── Admin Email Recipients ────────────────────────────────────────────────────

router.get('/admin-recipients', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, label, active FROM admin_recipients WHERE company_id = $1 ORDER BY id`,
      [req.companyId]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/admin-recipients', async (req, res) => {
  try {
    const { email, label } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const { rows } = await query(
      `INSERT INTO admin_recipients (company_id, email, label) VALUES ($1, $2, $3) RETURNING *`,
      [req.companyId, email.trim().toLowerCase(), (label || '').trim() || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/admin-recipients/:id', async (req, res) => {
  try {
    await query(`DELETE FROM admin_recipients WHERE id = $1 AND company_id = $2`, [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Notification Settings ─────────────────────────────────────────────────────

router.get('/notification-settings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM notification_settings WHERE company_id = $1`,
      [req.companyId]
    );
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.put('/notification-settings', async (req, res) => {
  try {
    const allowed = ['time_night', 'time_morning', 'time_midday'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        await query(
          `INSERT INTO notification_settings (company_id, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [req.companyId, key, req.body[key]]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Clear Data ────────────────────────────────────────────────────────────────

router.delete('/clear/time-records', async (req, res) => {
  try {
    await query(`DELETE FROM media WHERE record_id IN (SELECT id FROM work_records WHERE project_name IS NULL AND company_id = $1)`, [req.companyId]);
    const { rowCount } = await query(`DELETE FROM work_records WHERE project_name IS NULL AND company_id = $1`, [req.companyId]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

router.delete('/clear/projects', async (req, res) => {
  try {
    await query(`DELETE FROM media WHERE record_id IN (SELECT id FROM work_records WHERE project_name IS NOT NULL AND company_id = $1)`, [req.companyId]);
    const { rowCount } = await query(`DELETE FROM work_records WHERE project_name IS NOT NULL AND company_id = $1`, [req.companyId]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

router.delete('/clear/calendar-jobs', async (req, res) => {
  try {
    const { rowCount } = await query(`DELETE FROM scheduled_jobs WHERE company_id = $1`, [req.companyId]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

router.delete('/clear/payroll', async (req, res) => {
  try {
    const { rowCount } = await query(`DELETE FROM payroll WHERE company_id = $1`, [req.companyId]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

router.delete('/clear/all', async (req, res) => {
  try {
    await query(`DELETE FROM media WHERE record_id IN (SELECT id FROM work_records WHERE company_id = $1)`, [req.companyId]);
    await query(`DELETE FROM work_records WHERE company_id = $1`, [req.companyId]);
    await query(`DELETE FROM scheduled_jobs WHERE company_id = $1`, [req.companyId]);
    await query(`DELETE FROM payroll WHERE company_id = $1`, [req.companyId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ─── Test Email ───────────────────────────────────────────────────────────────

router.post('/test-email', async (req, res) => {
  try {
    const { sendAdminSummary } = require('../services/email');
    const { rows: coRows } = await query('SELECT name FROM companies WHERE id = $1', [req.companyId]);
    const companyName = coRows[0]?.name || 'Company';

    const { rows } = await query(`SELECT email FROM admin_recipients WHERE company_id = $1 AND active = TRUE`, [req.companyId]);
    const emails = rows.map(r => r.email);
    if (!emails.length) return res.status(400).json({ error: 'No recipients configured' });

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    await sendAdminSummary(
      [{ title: 'Test Job', location: 'Test Address', start_time: '08:00', end_time: '16:00', notes: 'This is a test email from the system.', assigned_names: [] }],
      todayStr,
      emails,
      'Test Email',
      companyName
    );
    res.json({ ok: true, sent_to: emails });
  } catch (err) { console.error('[TestEmail] Error:', err.message); res.status(500).json({ error: err.message || 'Server error' }); }
});

// ─── Map Records ──────────────────────────────────────────────────────────────

router.get('/map-records', async (req, res) => {
  try {
    const { date_from, date_to, employee_id } = req.query;
    const params = [req.companyId];
    let sql = `
      SELECT wr.id, wr.user_id, u.name AS employee_name, wr.date,
             wr.clock_in, wr.clock_out,
             wr.clock_in_lat::float  AS clock_in_lat,
             wr.clock_in_lng::float  AS clock_in_lng,
             wr.clock_in_address,
             wr.clock_out_lat::float AS clock_out_lat,
             wr.clock_out_lng::float AS clock_out_lng,
             wr.clock_out_address,
             COALESCE(s.name, wr.project_name) AS location_name
      FROM work_records wr
      JOIN users u ON u.id = wr.user_id
      LEFT JOIN stores s ON s.id = wr.store_id
      WHERE wr.company_id = $1
        AND (wr.clock_in_lat IS NOT NULL OR wr.clock_out_lat IS NOT NULL)
    `;
    if (date_from)   { params.push(date_from);   sql += ` AND wr.date >= $${params.length}`; }
    if (date_to)     { params.push(date_to);     sql += ` AND wr.date <= $${params.length}`; }
    if (employee_id) { params.push(employee_id); sql += ` AND wr.user_id = $${params.length}`; }
    sql += ' ORDER BY wr.clock_in DESC LIMIT 1000';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Who's In Now ─────────────────────────────────────────────────────────────

router.get('/who-is-in', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wr.id, wr.clock_in, wr.user_id,
             u.name as employee_name,
             COALESCE(s.name, wr.project_name) as location_name,
             EXTRACT(EPOCH FROM (NOW() - wr.clock_in))/3600 as hours_elapsed,
             b.id as active_break_id,
             b.start_time as break_start
      FROM work_records wr
      JOIN users u ON u.id = wr.user_id
      LEFT JOIN stores s ON s.id = wr.store_id
      LEFT JOIN breaks b ON b.work_record_id = wr.id AND b.end_time IS NULL
      WHERE wr.company_id = $1 AND wr.clock_out IS NULL
      ORDER BY wr.clock_in DESC
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Overtime Alerts ──────────────────────────────────────────────────────────

router.get('/overtime', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.name,
             ROUND(SUM(
               EXTRACT(EPOCH FROM (COALESCE(wr.clock_out, NOW()) - wr.clock_in)) / 3600.0
               - COALESCE((
                   SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time, NOW()) - b.start_time)) / 3600.0)
                   FROM breaks b WHERE b.work_record_id = wr.id
               ), 0)
             )::numeric, 2) AS hours_this_week
      FROM work_records wr
      JOIN users u ON u.id = wr.user_id
      WHERE wr.company_id = $1
        AND wr.clock_in >= date_trunc('week', NOW())
      GROUP BY u.id, u.name
      HAVING SUM(
               EXTRACT(EPOCH FROM (COALESCE(wr.clock_out, NOW()) - wr.clock_in)) / 3600.0
               - COALESCE((
                   SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time, NOW()) - b.start_time)) / 3600.0)
                   FROM breaks b WHERE b.work_record_id = wr.id
               ), 0)
             ) >= 35
      ORDER BY hours_this_week DESC
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Rest Day Requests (admin) ────────────────────────────────────────────────

router.get('/rest-requests', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT rdr.*, u.name as employee_name,
             rv.name as reviewer_name
      FROM rest_day_requests rdr
      JOIN users u ON u.id = rdr.user_id
      LEFT JOIN users rv ON rv.id = rdr.reviewed_by
      WHERE rdr.company_id = $1
      ORDER BY rdr.created_at DESC
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.patch('/rest-requests/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'status must be approved or denied' });

    const { rows } = await query(
      `UPDATE rest_day_requests SET status=$1, reviewed_by=$2, reviewed_at=NOW()
       WHERE id=$3 AND company_id=$4 AND status='pending'
       RETURNING *`,
      [status, req.user.id, req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found or already reviewed' });

    if (status === 'approved') {
      const r = rows[0];
      await query(
        `INSERT INTO rest_days (company_id, user_id, date, store_ids, note)
         VALUES ($1, $2, $3, '{}', $4)
         ON CONFLICT (user_id, date) DO UPDATE SET note=$4`,
        [r.company_id, r.user_id, r.date, r.reason || null]
      );
    }

    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
