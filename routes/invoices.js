const router    = require('express').Router();
const path      = require('path');
const fs        = require('fs');
const PDFDocument = require('pdfkit');
const { query } = require('../database');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

function esc(s)       { return String(s || ''); }
function fmtMoney(n)  { return '$' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// ── List invoices ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM invoices WHERE company_id = $1';
    const params = [req.companyId];
    if (status) { sql += ' AND status = $2'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Get single ────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2',
      [req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Shared: compute totals ────────────────────────────────────────────────────

function computeTotals(items, taxRate) {
  const subtotal = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  const tax      = +((subtotal * Number(taxRate || 0)) / 100).toFixed(2);
  const total    = +(subtotal + tax).toFixed(2);
  return { subtotal: +subtotal.toFixed(2), tax, total };
}

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { invoice_number, invoice_date, due_date, po_number,
            client_name, client_address, client_email,
            items, tax_rate, notes } = req.body;

    if (!client_name)   return res.status(400).json({ error: 'Client name is required' });
    if (!invoice_date)  return res.status(400).json({ error: 'Invoice date is required' });

    const itemList = Array.isArray(items) ? items : [];
    const { subtotal, tax, total } = computeTotals(itemList, tax_rate);

    let invNum = (invoice_number || '').trim();
    if (!invNum) {
      const { rows: last } = await query(
        `SELECT invoice_number FROM invoices WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [req.companyId]
      );
      const n = last.length ? parseInt(last[0].invoice_number.replace(/\D/g, ''), 10) || 0 : 0;
      invNum = 'INV-' + String(n + 1).padStart(4, '0');
    }

    const { rows } = await query(`
      INSERT INTO invoices
        (company_id, invoice_number, invoice_date, due_date, po_number,
         client_name, client_address, client_email, items, subtotal, tax, total, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req.companyId, invNum, invoice_date, due_date || null, po_number || null,
        client_name, client_address || null, client_email || null,
        JSON.stringify(itemList), subtotal, tax, total, notes || null]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Invoice number already exists' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const { invoice_number, invoice_date, due_date, po_number,
            client_name, client_address, client_email,
            items, tax_rate, notes } = req.body;

    if (!client_name)  return res.status(400).json({ error: 'Client name is required' });
    if (!invoice_date) return res.status(400).json({ error: 'Invoice date is required' });

    const itemList = Array.isArray(items) ? items : [];
    const { subtotal, tax, total } = computeTotals(itemList, tax_rate);

    const result = await query(`
      UPDATE invoices
         SET invoice_number=$1, invoice_date=$2, due_date=$3, po_number=$4,
             client_name=$5, client_address=$6, client_email=$7,
             items=$8, subtotal=$9, tax=$10, total=$11, notes=$12
       WHERE id=$13 AND company_id=$14
    `, [invoice_number, invoice_date, due_date || null, po_number || null,
        client_name, client_address || null, client_email || null,
        JSON.stringify(itemList), subtotal, tax, total, notes || null,
        req.params.id, req.companyId]);

    if (!result.rowCount) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Invoice number already exists' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

// ── Toggle paid / pending ─────────────────────────────────────────────────────

router.patch('/:id/status', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT status FROM invoices WHERE id = $1 AND company_id = $2',
      [req.params.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const newStatus = rows[0].status === 'paid' ? 'pending' : 'paid';
    await query(
      'UPDATE invoices SET status=$1, paid_at=$2 WHERE id=$3 AND company_id=$4',
      [newStatus, newStatus === 'paid' ? new Date() : null, req.params.id, req.companyId]
    );
    res.json({ status: newStatus });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoices WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── PDF — Wave-style layout ───────────────────────────────────────────────────

router.get('/:id/pdf', async (req, res) => {
  try {
    const { rows: invRows } = await query(
      'SELECT * FROM invoices WHERE id=$1 AND company_id=$2',
      [req.params.id, req.companyId]
    );
    if (!invRows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = invRows[0];

    const { rows: coRows } = await query(
      'SELECT name, logo_url FROM companies WHERE id=$1',
      [req.companyId]
    );
    const company = coRows[0] || { name: 'Company' };

    const items = Array.isArray(inv.items) ? inv.items : JSON.parse(inv.items || '[]');

    const doc = new PDFDocument({ margin: 0, size: 'LETTER', compress: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${inv.invoice_number}.pdf"`);
    doc.pipe(res);

    // ── Design tokens ────────────────────────────────────────────────
    const BLUE   = '#1D5BF0';
    const DARK   = '#0C1822';
    const MUTED  = '#6B7280';
    const BORDER = '#E5E7EB';
    const STRIPE = '#F9FAFB';
    const GREEN  = '#059669';
    const PW     = 612;   // page width (pts)
    const PH     = 792;   // page height (pts)
    const ML     = 48;    // margin left
    const MR     = PW - 48; // margin right
    const CNTW   = MR - ML;

    // ── Top accent bar ───────────────────────────────────────────────
    doc.rect(0, 0, PW, 5).fill(BLUE);

    // ── Company info (left) ──────────────────────────────────────────
    const HEADER_Y = 28;
    const logoPath = path.join(__dirname, '..', 'public', 'images', 'logo.png');
    let nameX = ML;
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, ML, HEADER_Y, { height: 40, fit: [70, 40] });
        nameX = ML + 78;
      } catch (_) {}
    }
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(16).text(esc(company.name), nameX, HEADER_Y + 6, { width: 240 });

    // ── "INVOICE" title (right) ──────────────────────────────────────
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(30)
       .text('INVOICE', ML, HEADER_Y, { width: CNTW, align: 'right' });
    doc.fillColor(MUTED).font('Helvetica').fontSize(10)
       .text(esc(inv.invoice_number), ML, HEADER_Y + 34, { width: CNTW, align: 'right' });

    // ── Divider ──────────────────────────────────────────────────────
    const DIV_Y = HEADER_Y + 58;
    doc.moveTo(ML, DIV_Y).lineTo(MR, DIV_Y).strokeColor(BORDER).lineWidth(1).stroke();

    // ── Bill To + Invoice details ────────────────────────────────────
    const INFO_Y = DIV_Y + 14;
    const COL2_X = ML + CNTW * 0.5 + 16;
    const COL2_W = MR - COL2_X;

    // Bill To (left)
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
       .text('BILL TO', ML, INFO_Y, { characterSpacing: 0.8 });
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(11)
       .text(esc(inv.client_name), ML, INFO_Y + 13, { width: CNTW * 0.46 });
    let billY = INFO_Y + 28;
    if (inv.client_address) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text(esc(inv.client_address), ML, billY, { width: CNTW * 0.46 });
      billY += 13 * (Math.ceil(inv.client_address.length / 38) + 1);
    }
    if (inv.client_email) {
      doc.fillColor(BLUE).font('Helvetica').fontSize(9)
         .text(esc(inv.client_email), ML, billY);
      billY += 13;
    }

    // Invoice details (right)
    const detRows = [
      ['Invoice Date', esc(inv.invoice_date)],
      inv.due_date  ? ['Due Date',   esc(inv.due_date)]  : null,
      inv.po_number ? ['PO Number',  esc(inv.po_number)] : null,
    ].filter(Boolean);
    let detY = INFO_Y;
    detRows.forEach(([label, val]) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(label, COL2_X, detY, { width: COL2_W * 0.5 });
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(8.5)
         .text(val, COL2_X + COL2_W * 0.5, detY, { width: COL2_W * 0.5, align: 'right' });
      detY += 16;
    });

    // Status pill
    if (inv.status === 'paid') {
      const PILL_W = 52;
      const PILL_X = MR - PILL_W;
      doc.roundedRect(PILL_X, detY + 4, PILL_W, 16, 8).fill('#D1FAE5');
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(7.5)
         .text('✓  PAID', PILL_X, detY + 8, { width: PILL_W, align: 'center' });
      detY += 24;
    }

    // ── Items table ──────────────────────────────────────────────────
    const TABLE_Y = Math.max(INFO_Y + 84, billY + 16, detY + 16);
    const THEAD_H = 22;

    // Column positions
    const C_DESC  = ML;
    const C_QTY   = ML + CNTW * 0.54;
    const C_UPRICE= ML + CNTW * 0.70;
    const C_AMT   = ML + CNTW * 0.85;
    const C_LAST  = MR;

    doc.rect(ML, TABLE_Y, CNTW, THEAD_H).fill(DARK);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5);
    doc.text('DESCRIPTION', C_DESC + 6, TABLE_Y + 7, { width: CNTW * 0.52 });
    doc.text('QTY',         C_QTY,       TABLE_Y + 7, { width: CNTW * 0.14, align: 'right' });
    doc.text('UNIT PRICE',  C_UPRICE,    TABLE_Y + 7, { width: CNTW * 0.14, align: 'right' });
    doc.text('AMOUNT',      C_AMT,       TABLE_Y + 7, { width: C_LAST - C_AMT - 4, align: 'right' });

    let rowY = TABLE_Y + THEAD_H;
    items.forEach((item, idx) => {
      const ROW_H = 24;
      if (idx % 2 === 1) doc.rect(ML, rowY, CNTW, ROW_H).fill(STRIPE);
      const amt = Number(item.quantity || 0) * Number(item.unit_price || 0);
      doc.fillColor(DARK).font('Helvetica').fontSize(9)
         .text(esc(item.description), C_DESC + 6, rowY + 7, { width: CNTW * 0.5 });
      doc.text(String(Number(item.quantity || 0)), C_QTY, rowY + 7, { width: CNTW * 0.14, align: 'right' });
      doc.text(fmtMoney(item.unit_price), C_UPRICE, rowY + 7, { width: CNTW * 0.14, align: 'right' });
      doc.font('Helvetica-Bold').text(fmtMoney(amt), C_AMT, rowY + 7, { width: C_LAST - C_AMT - 4, align: 'right' });
      doc.moveTo(ML, rowY + ROW_H).lineTo(MR, rowY + ROW_H).strokeColor(BORDER).lineWidth(0.4).stroke();
      rowY += ROW_H;
    });
    if (!items.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('No items', C_DESC + 6, rowY + 8);
      rowY += 24;
    }

    // ── Totals ───────────────────────────────────────────────────────
    const TOT_X = ML + CNTW * 0.55;
    const TOT_W = MR - TOT_X;
    let totY = rowY + 16;

    const totRow = (label, val, bold = false, color = DARK) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, TOT_X, totY, { width: TOT_W * 0.52 });
      doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
         .text(val, TOT_X + TOT_W * 0.52, totY, { width: TOT_W * 0.48, align: 'right' });
      totY += 16;
    };

    totRow('Subtotal', fmtMoney(inv.subtotal));
    if (Number(inv.tax) > 0) totRow('Tax', fmtMoney(inv.tax));

    // Total box
    doc.rect(TOT_X - 8, totY, TOT_W + 8, 28).fill(BLUE);
    doc.fillColor('#fff').font('Helvetica').fontSize(9).text('TOTAL DUE', TOT_X, totY + 9, { width: TOT_W * 0.52 });
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(14)
       .text(fmtMoney(inv.total), TOT_X + TOT_W * 0.52, totY + 7, { width: TOT_W * 0.48, align: 'right' });
    totY += 40;

    // ── Notes ────────────────────────────────────────────────────────
    if (inv.notes) {
      totY += 10;
      doc.moveTo(ML, totY).lineTo(MR, totY).strokeColor(BORDER).lineWidth(0.5).stroke();
      totY += 10;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('NOTES', ML, totY, { characterSpacing: 0.8 });
      doc.fillColor(DARK).font('Helvetica').fontSize(9).text(esc(inv.notes), ML, totY + 12, { width: CNTW });
    }

    // ── Footer ───────────────────────────────────────────────────────
    doc.rect(0, PH - 34, PW, 34).fill(DARK);
    doc.fillColor('rgba(255,255,255,0.5)').font('Helvetica').fontSize(8)
       .text(esc(company.name), ML, PH - 20, { width: CNTW / 2 });
    doc.fillColor('rgba(255,255,255,0.5)').font('Helvetica').fontSize(8)
       .text('Thank you for your business', ML, PH - 20, { width: CNTW, align: 'right' });

    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
