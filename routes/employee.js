const router = require('express').Router();
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

router.use(requireAuth);

// Get stores list
router.get('/stores', (req, res) => {
  const stores = db.prepare('SELECT * FROM stores ORDER BY name').all();
  res.json(stores);
});

// Get current open record for this employee
router.get('/current-record', (req, res) => {
  const record = db.prepare(
    'SELECT wr.*, s.name as store_name FROM work_records wr JOIN stores s ON s.id = wr.store_id WHERE wr.user_id = ? AND wr.clock_out IS NULL ORDER BY wr.clock_in DESC LIMIT 1'
  ).get(req.user.id);
  res.json(record || null);
});

// Clock In
router.post('/clock-in', upload.array('media', 10), (req, res) => {
  const { store_id } = req.body;
  if (!store_id) return res.status(400).json({ error: 'Store required' });

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one photo or video is required' });
  }

  // Check no open record
  const open = db.prepare(
    'SELECT id FROM work_records WHERE user_id = ? AND clock_out IS NULL'
  ).get(req.user.id);
  if (open) return res.status(400).json({ error: 'You already have an open shift. Clock out first.' });

  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const clockIn = now.toISOString();

  const result = db.prepare(
    'INSERT INTO work_records (user_id, store_id, clock_in, date) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, store_id, clockIn, date);

  const recordId = result.lastInsertRowid;

  // Save media
  const insertMedia = db.prepare(
    'INSERT INTO media (record_id, filename, original_name, mime_type, type, url) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const file of req.files) {
    insertMedia.run(recordId, file.filename, file.originalname, file.mimetype, 'clock_in', file.path || null);
  }

  res.status(201).json({ id: recordId, clock_in: clockIn });
});

// Clock Out
router.post('/clock-out', upload.array('media', 10), (req, res) => {
  const { record_id, notes } = req.body;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one photo or video is required' });
  }

  const record = db.prepare(
    'SELECT * FROM work_records WHERE id = ? AND user_id = ? AND clock_out IS NULL'
  ).get(record_id, req.user.id);

  if (!record) return res.status(404).json({ error: 'Open record not found' });

  const clockOut = new Date().toISOString();

  db.prepare(
    'UPDATE work_records SET clock_out = ?, notes = ? WHERE id = ?'
  ).run(clockOut, notes || null, record.id);

  const insertMedia = db.prepare(
    'INSERT INTO media (record_id, filename, original_name, mime_type, type, url) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const file of req.files) {
    insertMedia.run(record.id, file.filename, file.originalname, file.mimetype, 'clock_out', file.path || null);
  }

  res.json({ success: true, clock_out: clockOut });
});

// Get own records
router.get('/my-records', (req, res) => {
  const records = db.prepare(`
    SELECT wr.id, s.name as store, wr.date, wr.clock_in, wr.clock_out,
           COUNT(m.id) as media_count
    FROM work_records wr
    JOIN stores s ON s.id = wr.store_id
    LEFT JOIN media m ON m.record_id = wr.id
    WHERE wr.user_id = ?
    GROUP BY wr.id
    ORDER BY wr.date DESC, wr.clock_in DESC
    LIMIT 30
  `).all(req.user.id);
  res.json(records);
});

module.exports = router;
