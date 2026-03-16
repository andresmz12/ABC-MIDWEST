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
      'SELECT wr.*, s.name as store_name FROM work_records wr JOIN stores s ON s.id = wr.store_id WHERE wr.user_id = $1 AND wr.clock_out IS NULL ORDER BY wr.clock_in DESC LIMIT 1',
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clock In
router.post('/clock-in', upload.array('media', 10), async (req, res) => {
  try {
    const { store_id, lat, lng, project_name } = req.body;
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
      'INSERT INTO work_records (user_id, store_id, project_name, clock_in, date, clock_in_lat, clock_in_lng) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [req.user.id, store_id || null, project_name || null, clockIn, date, lat || null, lng || null]
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
    const { record_id, notes, lat, lng } = req.body;

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
      'UPDATE work_records SET clock_out = $1, notes = $2, clock_out_lat = $3, clock_out_lng = $4 WHERE id = $5',
      [clockOut, notes || null, lat || null, lng || null, record.id]
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

// Get own records
router.get('/my-records', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wr.id, s.name as store, wr.date, wr.clock_in, wr.clock_out,
             COUNT(m.id) as media_count
      FROM work_records wr
      JOIN stores s ON s.id = wr.store_id
      LEFT JOIN media m ON m.record_id = wr.id
      WHERE wr.user_id = $1
      GROUP BY wr.id, s.name
      ORDER BY wr.date DESC, wr.clock_in DESC
      LIMIT 30
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
