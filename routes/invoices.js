const router = require('express').Router();
const PDFDocument = require('pdfkit');
const { query } = require('../database');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// ── List all invoices ─────────────────────────────────────────────────────────
router.get('/invoices', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, invoice_number, invoice_date, client_name, total, status, paid_at, created_at
       FROM invoices ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get single invoice ────────────────────────────────────────────────────────
router.get('/invoices/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Create invoice ────────────────────────────────────────────────────────────
router.post('/invoices', async (req, res) => {
  try {
    const { invoice_number, invoice_date, client_name, client_address, client_email,
            items, tax, notes } = req.body;
    if (!invoice_number || !invoice_date || !client_name) {
      return res.status(400).json({ error: 'invoice_number, invoice_date and client_name are required' });
    }
    const parsedItems = Array.isArray(items) ? items : [];
    const subtotal = parsedItems.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    const taxAmt   = parseFloat(tax) || 0;
    const total    = subtotal + taxAmt;

    const { rows } = await query(
      `INSERT INTO invoices (invoice_number, invoice_date, client_name, client_address,
        client_email, items, subtotal, tax, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [invoice_number, invoice_date, client_name, client_address || null,
       client_email || null, JSON.stringify(parsedItems), subtotal, taxAmt, total, notes || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Invoice number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── Update invoice ────────────────────────────────────────────────────────────
router.put('/invoices/:id', async (req, res) => {
  try {
    const { invoice_number, invoice_date, client_name, client_address, client_email,
            items, tax, notes } = req.body;
    if (!invoice_number || !invoice_date || !client_name) {
      return res.status(400).json({ error: 'invoice_number, invoice_date and client_name are required' });
    }
    const parsedItems = Array.isArray(items) ? items : [];
    const subtotal = parsedItems.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    const taxAmt   = parseFloat(tax) || 0;
    const total    = subtotal + taxAmt;

    await query(
      `UPDATE invoices SET invoice_number=$1, invoice_date=$2, client_name=$3,
        client_address=$4, client_email=$5, items=$6, subtotal=$7, tax=$8, total=$9, notes=$10
       WHERE id=$11`,
      [invoice_number, invoice_date, client_name, client_address || null,
       client_email || null, JSON.stringify(parsedItems), subtotal, taxAmt, total,
       notes || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Invoice number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── Mark as paid ──────────────────────────────────────────────────────────────
router.patch('/invoices/:id/mark-paid', async (req, res) => {
  try {
    await query(
      `UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete invoice ────────────────────────────────────────────────────────────
router.delete('/invoices/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoices WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Download PDF ──────────────────────────────────────────────────────────────
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = rows[0];
    const items = Array.isArray(inv.items) ? inv.items : JSON.parse(inv.items || '[]');

    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${inv.invoice_number}.pdf"`);
    doc.pipe(res);

    const blue  = '#1a56db';
    const dark  = '#111827';
    const muted = '#6b7280';
    const pageW = doc.page.width - 100; // usable width (margins 50 each side)

    // ── Header ───────────────────────────────────────────────────────────────
    doc.rect(50, 50, pageW, 70).fill(blue);
    doc.fillColor('#fff').fontSize(22).font('Helvetica-Bold')
       .text('ABC Midwest Cleaning', 65, 63);
    doc.fontSize(11).font('Helvetica').text('Professional Cleaning Services', 65, 90);

    // Invoice label (right side of header)
    doc.fontSize(28).font('Helvetica-Bold').fillColor('#fff')
       .text('INVOICE', 0, 63, { align: 'right', width: pageW + 50 });
    doc.fontSize(11).font('Helvetica')
       .text(`#${inv.invoice_number}`, 0, 95, { align: 'right', width: pageW + 50 });

    // ── Invoice meta ─────────────────────────────────────────────────────────
    let y = 140;
    doc.fillColor(dark).fontSize(11).font('Helvetica-Bold').text('Invoice Date:', 50, y);
    doc.font('Helvetica').text(inv.invoice_date, 160, y);
    if (inv.status === 'paid') {
      doc.fillColor('#16a34a').font('Helvetica-Bold').text('PAID', 0, y, { align: 'right', width: pageW + 50 });
    } else {
      doc.fillColor('#dc2626').font('Helvetica-Bold').text('PENDING', 0, y, { align: 'right', width: pageW + 50 });
    }

    // ── Bill To ───────────────────────────────────────────────────────────────
    y = 185;
    doc.fillColor(blue).fontSize(10).font('Helvetica-Bold').text('BILL TO', 50, y);
    doc.moveTo(50, y + 14).lineTo(pageW + 50, y + 14).stroke(blue);
    y += 20;
    doc.fillColor(dark).fontSize(12).font('Helvetica-Bold').text(inv.client_name, 50, y);
    y += 18;
    if (inv.client_address) {
      doc.fontSize(10).font('Helvetica').fillColor(muted).text(inv.client_address, 50, y);
      y += 14;
    }
    if (inv.client_email) {
      doc.fontSize(10).font('Helvetica').fillColor(muted).text(inv.client_email, 50, y);
      y += 14;
    }

    // ── Items table ───────────────────────────────────────────────────────────
    y += 20;
    const colDesc  = 50;
    const colQty   = 310;
    const colPrice = 380;
    const colSub   = 460;

    // Table header
    doc.rect(50, y, pageW, 22).fill(dark);
    doc.fillColor('#fff').fontSize(10).font('Helvetica-Bold');
    doc.text('Description', colDesc + 5, y + 6);
    doc.text('Qty',   colQty,   y + 6, { width: 60, align: 'right' });
    doc.text('Price', colPrice, y + 6, { width: 70, align: 'right' });
    doc.text('Subtotal', colSub, y + 6, { width: 55, align: 'right' });
    y += 22;

    // Table rows
    items.forEach((item, idx) => {
      const rowH = 22;
      if (idx % 2 === 0) doc.rect(50, y, pageW, rowH).fill('#f3f4f6');
      doc.fillColor(dark).fontSize(10).font('Helvetica');
      doc.text(String(item.description || ''), colDesc + 5, y + 6, { width: colQty - colDesc - 10 });
      doc.text(String(item.quantity   || 0),   colQty,   y + 6, { width: 60, align: 'right' });
      doc.text(`$${parseFloat(item.unit_price || 0).toFixed(2)}`, colPrice, y + 6, { width: 70, align: 'right' });
      doc.text(`$${parseFloat(item.subtotal   || 0).toFixed(2)}`, colSub,   y + 6, { width: 55, align: 'right' });
      y += rowH;
    });

    // Table bottom border
    doc.moveTo(50, y).lineTo(pageW + 50, y).lineWidth(1).stroke('#e5e7eb');

    // ── Totals ────────────────────────────────────────────────────────────────
    y += 12;
    const labelX = 380;
    const valueX = 460;
    const valW   = 55;

    doc.fillColor(muted).fontSize(10).font('Helvetica');
    doc.text('Subtotal:', labelX, y, { width: 70, align: 'right' });
    doc.fillColor(dark).text(`$${parseFloat(inv.subtotal || 0).toFixed(2)}`, valueX, y, { width: valW, align: 'right' });
    y += 16;
    doc.fillColor(muted).text('Tax:', labelX, y, { width: 70, align: 'right' });
    doc.fillColor(dark).text(`$${parseFloat(inv.tax || 0).toFixed(2)}`, valueX, y, { width: valW, align: 'right' });
    y += 10;
    doc.moveTo(labelX, y).lineTo(pageW + 50, y).lineWidth(1).stroke(blue);
    y += 8;
    doc.fillColor(blue).fontSize(13).font('Helvetica-Bold');
    doc.text('TOTAL:', labelX, y, { width: 70, align: 'right' });
    doc.text(`$${parseFloat(inv.total || 0).toFixed(2)}`, valueX, y, { width: valW, align: 'right' });

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (inv.notes) {
      y += 36;
      doc.fillColor(blue).fontSize(10).font('Helvetica-Bold').text('NOTES', 50, y);
      doc.moveTo(50, y + 14).lineTo(pageW + 50, y + 14).lineWidth(0.5).stroke(blue);
      y += 20;
      doc.fillColor(muted).fontSize(10).font('Helvetica').text(inv.notes, 50, y, { width: pageW });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.fillColor(muted).fontSize(9).font('Helvetica')
       .text('Thank you for your business.', 50, doc.page.height - 60, { align: 'center', width: pageW });

    doc.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
