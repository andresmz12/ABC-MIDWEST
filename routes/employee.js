const router = require('express').Router();
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

router.use(requireAuth);

// Get stores assigned to this employee
router.get('/stores', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT s.* FROM stores s INNER JOIN user_stores us ON us.store_id = s.id WHERE us.user_id = $1 ORDER BY s.name',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get current open record for this employee
router.get('/current-record', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT wr.*, s.name as store_name,
              COALESCE(s.name, wr.project_name) as display_name
       FROM work_records wr
       LEFT JOIN stores s ON s.id = wr.store_id
       WHERE wr.user_id = $1 AND wr.clock_out IS NULL
       ORDER BY wr.clock_in DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clock In
router.post('/clock-in', upload.array('media', 10), async (req, res) => {
  try {
    const { store_id, lat, lng, project_name, address } = req.body;
    if (!store_id && !project_name) return res.status(400).json({ error: 'Store or project name required' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'At least one photo or video is required' });
    }

    // Check no open record
    const { rows: open } = await query(
      'SELECT id FROM work_records WHERE user_id = $1 AND clock_out IS NULL',
      [req.user.id]
    );
    if (open.length) return res.status(400).json({ error: 'You already have an open shift. Clock out first.' });

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const clockIn = now.toISOString();

    const { rows } = await query(
      'INSERT INTO work_records (user_id, store_id, project_name, clock_in, date, clock_in_lat, clock_in_lng, clock_in_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [req.user.id, store_id || null, project_name || null, clockIn, date, lat || null, lng || null, address || null]
    );
    const recordId = rows[0].id;

    for (const file of req.files) {
      await query(
        'INSERT INTO media (record_id, filename, original_name, mime_type, type, url) VALUES ($1, $2, $3, $4, $5, $6)',
        [recordId, file.filename, file.originalname, file.mimetype, 'clock_in', file.path || null]
      );
    }

    res.status(201).json({ id: recordId, clock_in: clockIn });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clock Out
router.post('/clock-out', upload.array('media', 10), async (req, res) => {
  try {
    const { record_id, notes, lat, lng, address } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'At least one photo or video is required' });
    }

    const { rows } = await query(
      'SELECT * FROM work_records WHERE id = $1 AND user_id = $2 AND clock_out IS NULL',
      [record_id, req.user.id]
    );
    const record = rows[0];
    if (!record) return res.status(404).json({ error: 'Open record not found' });

    const clockOut = new Date().toISOString();

    await query(
      'UPDATE work_records SET clock_out = $1, notes = $2, clock_out_lat = $3, clock_out_lng = $4, clock_out_address = $5 WHERE id = $6',
      [clockOut, notes || null, lat || null, lng || null, address || null, record.id]
    );

    for (const file of req.files) {
      await query(
        'INSERT INTO media (record_id, filename, original_name, mime_type, type, url) VALUES ($1, $2, $3, $4, $5, $6)',
        [record.id, file.filename, file.originalname, file.mimetype, 'clock_out', file.path || null]
      );
    }

    res.json({ success: true, clock_out: clockOut });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get media for a specific record (employee can only see their own records)
router.get('/records/:id/media', async (req, res) => {
  try {
    const { rows: owned } = await query(
      'SELECT id FROM work_records WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!owned.length) return res.status(404).json({ error: 'Record not found' });

    const { rows } = await query(
      'SELECT * FROM media WHERE record_id = $1 ORDER BY type, uploaded_at',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get own records
router.get('/my-records', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wr.id, s.name as store, wr.project_name, wr.date, wr.clock_in, wr.clock_out,
             COUNT(m.id) as media_count
      FROM work_records wr
      LEFT JOIN stores s ON s.id = wr.store_id
      LEFT JOIN media m ON m.record_id = wr.id
      WHERE wr.user_id = $1
      GROUP BY wr.id, s.name, wr.project_name
      ORDER BY wr.date DESC, wr.clock_in DESC
      LIMIT 60
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Rest Days ────────────────────────────────────────────────────────────────

router.get('/rest-days', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT rd.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id',s.id,'name',s.name) ORDER BY s.name)
           FROM stores s WHERE s.id = ANY(rd.store_ids)), '[]'
        ) as stores
       FROM rest_days rd WHERE rd.user_id = $1 ORDER BY rd.date DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rest-days', async (req, res) => {
  try {
    const { date, store_ids, note } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const storeArr = Array.isArray(store_ids) ? store_ids : [];
    if (!storeArr.length) return res.status(400).json({ error: 'At least one store required' });
    const { rows } = await query(
      `INSERT INTO rest_days (user_id, date, store_ids, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, date) DO UPDATE SET store_ids=$3, note=$4
       RETURNING *`,
      [req.user.id, date, storeArr, note || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rest-days/:id', async (req, res) => {
  try {
    await query('DELETE FROM rest_days WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Employee Calendar (read/write if in calendar_access) ────────────────────
async function checkCalendarAccess(userId) {
  const { rows } = await query('SELECT 1 FROM calendar_access WHERE user_id=$1', [userId]);
  return rows.length > 0;
}

router.get('/calendar', async (req, res) => {
  try {
    if (!await checkCalendarAccess(req.user.id)) return res.status(403).json({ error: 'No calendar access' });
    const { month } = req.query;
    let sql = 'SELECT * FROM scheduled_jobs';
    const params = [];
    if (month) { sql += ' WHERE scheduled_date LIKE $1'; params.push(month + '%'); }
    sql += ' ORDER BY scheduled_date, id';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calendar', async (req, res) => {
  try {
    if (!await checkCalendarAccess(req.user.id)) return res.status(403).json({ error: 'No calendar access' });
    const { title, scheduled_date, location, notes } = req.body;
    if (!title || !scheduled_date) return res.status(400).json({ error: 'title and scheduled_date required' });
    const { rows } = await query(
      'INSERT INTO scheduled_jobs (title, scheduled_date, assigned_to, location, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [title, scheduled_date, [], location || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/calendar/:id', async (req, res) => {
  try {
    if (!await checkCalendarAccess(req.user.id)) return res.status(403).json({ error: 'No calendar access' });
    const { title, scheduled_date, location, notes } = req.body;
    if (!title || !scheduled_date) return res.status(400).json({ error: 'title and scheduled_date required' });
    await query(
      'UPDATE scheduled_jobs SET title=$1, scheduled_date=$2, location=$3, notes=$4 WHERE id=$5',
      [title, scheduled_date, location || null, notes || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/calendar/:id', async (req, res) => {
  try {
    if (!await checkCalendarAccess(req.user.id)) return res.status(403).json({ error: 'No calendar access' });
    await query('DELETE FROM scheduled_jobs WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
