'use strict';
const router = require('express').Router();
const { query } = require('../database');
const { uploadDoc, cloudinary } = require('../middleware/upload');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    let sql = `
      SELECT d.*, u.name AS uploader_name
      FROM documents d
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.company_id = $1
    `;
    const params = [req.companyId];
    if (category && category !== 'all') { sql += ' AND d.category = $2'; params.push(category); }
    sql += ' ORDER BY d.created_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Upload ────────────────────────────────────────────────────────────────────

router.post('/', uploadDoc.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { name, category, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Document name is required' });

    const url      = req.file.path || req.file.secure_url || req.file.url || null;
    const filename = req.file.filename || req.file.public_id || String(req.file.originalname);

    const { rows } = await query(
      `INSERT INTO documents (company_id,name,category,filename,original_name,mime_type,url,size,uploaded_by,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.companyId, name.trim(), category || 'other', filename,
       req.file.originalname, req.file.mimetype, url,
       req.file.size || null, req.user.id, notes?.trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Update (rename / change notes) ───────────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const { name, category, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Document name is required' });
    const { rows } = await query(
      `UPDATE documents SET name=$1,category=$2,notes=$3 WHERE id=$4 AND company_id=$5 RETURNING *`,
      [name?.trim(), category, notes?.trim() || null, req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM documents WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const doc = rows[0];

    if (doc.filename) {
      try {
        const rt = doc.mime_type.startsWith('image/') ? 'image' : 'raw';
        await cloudinary.uploader.destroy(doc.filename, { resource_type: rt });
      } catch (_) {}
    }

    await query('DELETE FROM documents WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
