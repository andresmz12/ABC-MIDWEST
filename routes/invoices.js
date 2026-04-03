const router  = require('express').Router();
const path    = require('path');
const fs      = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { query } = require('../database');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// ── List all invoices ─────────────────────────────────────────────────────────
router.get('/invoices', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, invoice_number, invoice_date, due_date, po_number,
              client_name, total, status, paid_at, created_at
       FROM invoices ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Export invoices to Excel grouped by company ───────────────────────────────
router.get('/invoices/export', async (req, res) => {
  try {
    const { status } = req.query; // optional: 'paid' | 'pending'
    let sql = `SELECT id, invoice_number, invoice_date, due_date, po_number,
                      client_name, subtotal, tax, total, status, paid_at
               FROM invoices`;
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY client_name, invoice_date';
    const { rows } = await query(sql, params);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ABC Midwest Cleaning';
    const ws = wb.addWorksheet('Invoices');

    // Header row
    ws.columns = [
      { header: 'Invoice #',   key: 'invoice_number', width: 18 },
      { header: 'Date',        key: 'invoice_date',   width: 14 },
      { header: 'Due Date',    key: 'due_date',        width: 14 },
      { header: 'PO #',        key: 'po_number',       width: 14 },
      { header: 'Company',     key: 'client_name',     width: 28 },
      { header: 'Subtotal',    key: 'subtotal',        width: 13 },
      { header: 'Tax',         key: 'tax',             width: 11 },
      { header: 'Total',       key: 'total',           width: 13 },
      { header: 'Status',      key: 'status',          width: 12 },
      { header: 'Paid At',     key: 'paid_at',         width: 20 },
    ];

    // Style header
    const hRow = ws.getRow(1);
    hRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } };
    hRow.alignment = { vertical: 'middle', horizontal: 'center' };
    hRow.height = 20;

    // Data rows
    rows.forEach(inv => {
      const row = ws.addRow({
        invoice_number: inv.invoice_number,
        invoice_date:   inv.invoice_date,
        due_date:       inv.due_date || '',
        po_number:      inv.po_number || '',
        client_name:    inv.client_name,
        subtotal:       parseFloat(inv.subtotal || 0),
        tax:            parseFloat(inv.tax || 0),
        total:          parseFloat(inv.total || 0),
        status:         inv.status === 'paid' ? 'Paid' : 'Pending',
        paid_at:        inv.paid_at ? new Date(inv.paid_at).toLocaleDateString() : '',
      });
      // Color status cell
      const statusCell = row.getCell('status');
      statusCell.font = { bold: true, color: { argb: inv.status === 'paid' ? 'FF16A34A' : 'FFDC2626' } };
      // Format money columns
      ['subtotal','tax','total'].forEach(k => {
        row.getCell(k).numFmt = '"$"#,##0.00';
      });
    });

    // Blank row before totals
    ws.addRow([]);

    // Company totals section
    const totalsTitle = ws.addRow(['TOTAL OWED BY COMPANY (PENDING)']);
    totalsTitle.font = { bold: true, size: 12 };
    ws.addRow(['Company', '', '', '', '', '', '', 'Total Owed']);
    const tHeader = ws.lastRow;
    tHeader.font = { bold: true };
    tHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };

    // Group by company, sum pending
    const byCompany = {};
    rows.forEach(inv => {
      if (inv.status !== 'paid') {
        if (!byCompany[inv.client_name]) byCompany[inv.client_name] = 0;
        byCompany[inv.client_name] += parseFloat(inv.total || 0);
      }
    });
    Object.entries(byCompany).sort().forEach(([name, total]) => {
      const r = ws.addRow([name, '', '', '', '', '', '', total]);
      r.getCell(8).numFmt = '"$"#,##0.00';
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices_export.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Invoice Clients Catalog ────────────────────────────────────────────────────
router.get('/invoice-clients', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoice_clients ORDER BY name');
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/invoice-clients', async (req, res) => {
  try {
    const { name, address, email } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await query(
      'INSERT INTO invoice_clients (name, address, email) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET address=$2, email=$3 RETURNING *',
      [name, address || null, email || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/invoice-clients/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoice_clients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Invoice Projects Catalog ───────────────────────────────────────────────────
router.get('/invoice-projects', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoice_projects ORDER BY name');
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/invoice-projects', async (req, res) => {
  try {
    const { name, default_price } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await query(
      'INSERT INTO invoice_projects (name, default_price) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET default_price=$2 RETURNING *',
      [name, parseFloat(default_price) || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/invoice-projects/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoice_projects WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Export invoices to PDF grouped by company ─────────────────────────────────
router.get('/invoices/export-pdf', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT id, invoice_number, invoice_date, due_date, po_number,
                      client_name, subtotal, tax, total, status, paid_at
               FROM invoices`;
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY client_name, invoice_date';
    const { rows } = await query(sql, params);

    const doc = new PDFDocument({ margin: 40, size: 'LETTER', compress: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices_report.pdf"');
    doc.pipe(res);

    const blue = '#1a56db'; const dark = '#111827'; const muted = '#6b7280'; const light = '#f3f4f6';
    const L = 40; const R = doc.page.width - 40; const W = R - L;

    // Header
    doc.rect(L, 40, W, 50).fill(blue);
    const logoPath = path.join(__dirname, '..', 'public', 'images', 'logo.png');
    let logoEndX = L + 10;
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, L + 8, 46, { height: 38, fit: [38, 38] }); logoEndX = L + 54; } catch (_) {}
    }
    doc.fillColor('#fff').fontSize(14).font('Helvetica-Bold').text('ABC Midwest Cleaning', logoEndX, 50, { width: 220 });
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.8)').text('Invoices Report', logoEndX, 67);
    const labelRight = status === 'pending' ? 'PENDING ONLY' : status === 'paid' ? 'PAID ONLY' : 'ALL INVOICES';
    doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold').text(labelRight, L, 55, { align: 'right', width: W });

    let y = 106;
    // Column widths
    const cW = { num: 80, date: 60, due: 60, po: 60, total: 65, status: 55 };
    const cX = {
      num:    L,
      date:   L + cW.num,
      due:    L + cW.num + cW.date,
      po:     L + cW.num + cW.date + cW.due,
      total:  R - cW.status - cW.total,
      status: R - cW.status,
    };
    // client column fills remaining space
    const clientX = cX.po + cW.po;
    const clientW = cX.total - clientX - 4;

    const drawTblHeader = (yy) => {
      doc.rect(L, yy, W, 16).fill(dark);
      doc.fillColor('#fff').fontSize(7.5).font('Helvetica-Bold');
      doc.text('Invoice #', cX.num + 2, yy + 4, { width: cW.num - 4 });
      doc.text('Date',      cX.date + 2, yy + 4, { width: cW.date - 4 });
      doc.text('Due',       cX.due + 2, yy + 4,  { width: cW.due - 4 });
      doc.text('PO #',      cX.po + 2, yy + 4,   { width: cW.po - 4 });
      doc.text('Client',    clientX + 2, yy + 4,  { width: clientW });
      doc.text('Total',     cX.total + 2, yy + 4, { width: cW.total - 4, align: 'right' });
      doc.text('Status',    cX.status + 2, yy + 4,{ width: cW.status - 2 });
      return yy + 16;
    };

    y = drawTblHeader(y);
    let rowIdx = 0;

    // Group by company
    const companies = [...new Set(rows.map(r => r.client_name))];
    const companyTotals = {};

    companies.forEach(company => {
      const compRows = rows.filter(r => r.client_name === company);
      // Company header
      if (y > doc.page.height - 100) { doc.addPage(); y = 40; y = drawTblHeader(y); rowIdx = 0; }
      doc.rect(L, y, W, 14).fill('#e8edf8');
      doc.fillColor(blue).fontSize(8.5).font('Helvetica-Bold').text(company, L + 4, y + 3, { width: W - 8 });
      y += 14;

      let compTotal = 0; let compPending = 0;
      compRows.forEach(inv => {
        if (y > doc.page.height - 80) { doc.addPage(); y = 40; y = drawTblHeader(y); rowIdx = 0; }
        if (rowIdx % 2 === 0) doc.rect(L, y, W, 14).fill(light);
        doc.fillColor(dark).fontSize(7.5).font('Helvetica');
        doc.text(inv.invoice_number || '', cX.num + 2, y + 3, { width: cW.num - 4 });
        doc.text(inv.invoice_date || '',   cX.date + 2, y + 3,{ width: cW.date - 4 });
        doc.text(inv.due_date || '–',      cX.due + 2, y + 3, { width: cW.due - 4 });
        doc.text(inv.po_number || '–',     cX.po + 2, y + 3,  { width: cW.po - 4 });
        doc.text(inv.client_name,          clientX + 2, y + 3, { width: clientW });
        doc.text(`$${parseFloat(inv.total||0).toFixed(2)}`, cX.total + 2, y + 3, { width: cW.total - 4, align: 'right' });
        const isPaid = inv.status === 'paid';
        doc.fillColor(isPaid ? '#16a34a' : '#dc2626').fontSize(7).font('Helvetica-Bold')
           .text(isPaid ? 'PAID' : 'PENDING', cX.status + 2, y + 3, { width: cW.status - 2 });
        compTotal += parseFloat(inv.total || 0);
        if (!isPaid) compPending += parseFloat(inv.total || 0);
        y += 14; rowIdx++;
      });
      companyTotals[company] = { total: compTotal, pending: compPending };
      // Company subtotal row
      doc.rect(L, y, W, 14).fill('#dbeafe');
      doc.fillColor(blue).fontSize(7.5).font('Helvetica-Bold')
         .text(`Subtotal ${company}: $${compTotal.toFixed(2)}  |  Pending: $${compPending.toFixed(2)}`, L + 4, y + 3, { width: W - 8 });
      y += 16;
    });

    // Summary section
    y += 8;
    if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
    doc.rect(L, y, W, 1).fill('#e5e7eb'); y += 12;
    doc.fillColor(blue).fontSize(11).font('Helvetica-Bold').text('SUMMARY — TOTAL OWED BY COMPANY', L, y); y += 18;
    doc.rect(L, y, W, 16).fill(dark);
    doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
    doc.text('Company', L + 4, y + 4, { width: 240 });
    doc.text('Total Pending', L + 250, y + 4, { width: 110, align: 'right' });
    doc.text('Total Invoiced', L + 370, y + 4, { width: 120, align: 'right' });
    y += 16;

    let grandPending = 0; let grandTotal = 0;
    Object.entries(companyTotals).sort().forEach(([name, t], idx) => {
      if (idx % 2 === 0) doc.rect(L, y, W, 14).fill(light);
      doc.fillColor(dark).fontSize(8).font('Helvetica');
      doc.text(name, L + 4, y + 3, { width: 240 });
      doc.fillColor(t.pending > 0 ? '#dc2626' : muted).font(t.pending > 0 ? 'Helvetica-Bold' : 'Helvetica')
         .text(`$${t.pending.toFixed(2)}`, L + 250, y + 3, { width: 110, align: 'right' });
      doc.fillColor(dark).font('Helvetica')
         .text(`$${t.total.toFixed(2)}`, L + 370, y + 3, { width: 120, align: 'right' });
      grandPending += t.pending; grandTotal += t.total;
      y += 14;
    });
    // Grand total
    doc.rect(L, y, W, 18).fill('#dbeafe');
    doc.fillColor(blue).fontSize(9).font('Helvetica-Bold');
    doc.text('GRAND TOTAL', L + 4, y + 4, { width: 240 });
    doc.text(`$${grandPending.toFixed(2)}`, L + 250, y + 4, { width: 110, align: 'right' });
    doc.text(`$${grandTotal.toFixed(2)}`, L + 370, y + 4, { width: 120, align: 'right' });

    // Footer
    const fY = doc.page.height - 45;
    doc.rect(L, fY - 4, W, 0.5).fill('#e5e7eb');
    doc.fillColor(muted).fontSize(8).font('Helvetica')
       .text('ABC Midwest Cleaning — Invoices Report', L, fY, { align: 'center', width: W });

    doc.end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Get single invoice ────────────────────────────────────────────────────────
router.get('/invoices/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Create invoice ────────────────────────────────────────────────────────────
router.post('/invoices', async (req, res) => {
  try {
    const { invoice_number, invoice_date, due_date, po_number,
            client_name, client_address, client_email,
            items, tax, notes } = req.body;
    if (!invoice_number || !invoice_date || !client_name) {
      return res.status(400).json({ error: 'invoice_number, invoice_date and client_name are required' });
    }
    const parsedItems = Array.isArray(items) ? items : [];
    const parsedItemsSafe = parsedItems.map(i => ({
      ...i,
      quantity:   parseFloat(i.quantity)   || 0,
      unit_price: parseFloat(i.unit_price) || 0,
      subtotal:   Math.round((parseFloat(i.quantity)||0) * (parseFloat(i.unit_price)||0) * 100) / 100
    }));
    const subtotal = Math.round(parsedItemsSafe.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    const taxAmt   = parseFloat(tax) || 0;
    const total    = subtotal + taxAmt;

    const { rows } = await query(
      `INSERT INTO invoices (invoice_number, invoice_date, due_date, po_number,
        client_name, client_address, client_email, items, subtotal, tax, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [invoice_number, invoice_date, due_date || null, po_number || null,
       client_name, client_address || null, client_email || null,
       JSON.stringify(parsedItemsSafe), subtotal, taxAmt, total, notes || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Invoice number already exists' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

// ── Update invoice ────────────────────────────────────────────────────────────
router.put('/invoices/:id', async (req, res) => {
  try {
    const { invoice_number, invoice_date, due_date, po_number,
            client_name, client_address, client_email,
            items, tax, notes } = req.body;
    if (!invoice_number || !invoice_date || !client_name) {
      return res.status(400).json({ error: 'invoice_number, invoice_date and client_name are required' });
    }
    const parsedItems = Array.isArray(items) ? items : [];
    const parsedItemsSafe = parsedItems.map(i => ({
      ...i,
      quantity:   parseFloat(i.quantity)   || 0,
      unit_price: parseFloat(i.unit_price) || 0,
      subtotal:   Math.round((parseFloat(i.quantity)||0) * (parseFloat(i.unit_price)||0) * 100) / 100
    }));
    const subtotal = Math.round(parsedItemsSafe.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    const taxAmt   = parseFloat(tax) || 0;
    const total    = subtotal + taxAmt;

    await query(
      `UPDATE invoices SET invoice_number=$1, invoice_date=$2, due_date=$3, po_number=$4,
        client_name=$5, client_address=$6, client_email=$7,
        items=$8, subtotal=$9, tax=$10, total=$11, notes=$12
       WHERE id=$13`,
      [invoice_number, invoice_date, due_date || null, po_number || null,
       client_name, client_address || null, client_email || null,
       JSON.stringify(parsedItemsSafe), subtotal, taxAmt, total,
       notes || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Invoice number already exists' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

// ── Mark as paid ──────────────────────────────────────────────────────────────
router.patch('/invoices/:id/mark-paid', async (req, res) => {
  try {
    await query(`UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Delete invoice ────────────────────────────────────────────────────────────
router.delete('/invoices/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoices WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Download PDF (Wave-style layout) ─────────────────────────────────────────
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv   = rows[0];
    const items = Array.isArray(inv.items) ? inv.items : JSON.parse(inv.items || '[]');

    const doc = new PDFDocument({ margin: 40, size: 'LETTER', compress: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${inv.invoice_number}.pdf"`);
    doc.pipe(res);

    const navy  = '#1a3a5c';
    const blue  = '#1a56db';
    const dark  = '#111827';
    const muted = '#6b7280';
    const lineC = '#e5e7eb';
    const hilit = '#eef2ff';
    const L = 40, R = doc.page.width - 40, W = R - L;

    // ── 1. Header — circular logo left, INVOICE + company right ──────────────
    // Fix: logo.png is a corrupt 1-byte file — use the JPEG as primary source
    const logoJpeg = path.join(__dirname, '..', 'public', 'images', 'WhatsApp Image 2026-03-15 at 15.01.42.jpeg');
    const logoPng  = path.join(__dirname, '..', 'public', 'images', 'logo.png');
    const logoFile = (fs.existsSync(logoJpeg) && fs.statSync(logoJpeg).size > 100) ? logoJpeg
                   : (fs.existsSync(logoPng)  && fs.statSync(logoPng).size  > 100) ? logoPng
                   : null;
    const logoR = 45, logoCX = L + logoR, logoCY = 40 + logoR;

    if (logoFile) {
      try {
        doc.save();
        doc.circle(logoCX, logoCY, logoR).clip();
        doc.image(logoFile, L, 40, { width: logoR * 2, height: logoR * 2 });
        doc.restore();
        doc.circle(logoCX, logoCY, logoR).lineWidth(1).stroke('#d1d5db');
      } catch (_) { /* skip logo on unexpected image error */ }
    }

    // "INVOICE" — large, right-aligned
    doc.fillColor(navy).fontSize(30).font('Helvetica-Bold')
       .text('INVOICE', L, 40, { align: 'right', width: W });

    // Company info — right-aligned (shifts down because larger logo)
    doc.fillColor(dark).fontSize(9).font('Helvetica-Bold')
       .text('ABC MIDWEST CLEANING SERVICES LLC', L, 85, { align: 'right', width: W });
    doc.fillColor(muted).fontSize(8.5).font('Helvetica')
       .text('CHICAGO, Illinois 60638', L, 99, { align: 'right', width: W })
       .text('United States', L, 112, { align: 'right', width: W });

    // Separator (at y=135, after 90px logo + padding)
    doc.moveTo(L, 135).lineTo(R, 135).lineWidth(0.5).stroke(lineC);

    // ── 2. Bill To (left) + Invoice meta (right) ──────────────────────────────
    let y = 150;

    // LEFT — Bill To
    doc.fillColor(muted).fontSize(7.5).font('Helvetica-Bold')
       .text('BILL TO', L, y);
    y += 13;
    doc.fillColor(dark).fontSize(11).font('Helvetica-Bold')
       .text(inv.client_name || '', L, y, { width: 255 });
    y += 17;
    if (inv.client_address) {
      doc.fillColor(muted).fontSize(8.5).font('Helvetica')
         .text(inv.client_address, L, y, { width: 255 });
      y += doc.heightOfString(inv.client_address, { width: 255 }) + 5;
    }
    if (inv.client_email) {
      doc.fillColor(muted).fontSize(8.5).font('Helvetica')
         .text(inv.client_email, L, y, { width: 255 });
      y += 13;
    }

    // RIGHT — Invoice meta key-value list
    const metaTopY = 150;
    const metaX    = R - 225;
    const metaLblW = 118;
    const metaValW = 107;

    const metaRows = [
      ['Invoice Number:',    inv.invoice_number || ''],
      ['P.O./S.O. Number:',  inv.po_number || '–'],
      ['Invoice Date:',      inv.invoice_date  || ''],
      ['Payment Due:',       inv.due_date || '–'],
    ];

    metaRows.forEach(([lbl, val], i) => {
      const ry = metaTopY + i * 17;
      doc.fillColor(muted).fontSize(8).font('Helvetica-Bold')
         .text(lbl, metaX, ry, { width: metaLblW });
      doc.fillColor(dark).fontSize(8).font('Helvetica')
         .text(val, metaX + metaLblW, ry, { width: metaValW, align: 'right' });
    });

    // Amount Due (USD) — highlighted box
    const adY = metaTopY + metaRows.length * 17 + 6;
    doc.rect(metaX - 6, adY - 3, metaLblW + metaValW + 12, 24).fill(hilit);
    doc.fillColor(navy).fontSize(8.5).font('Helvetica-Bold')
       .text('Amount Due (USD):', metaX, adY + 5, { width: metaLblW });
    doc.fillColor(navy).fontSize(10).font('Helvetica-Bold')
       .text(`$${parseFloat(inv.total || 0).toFixed(2)}`, metaX + metaLblW, adY + 4, { width: metaValW, align: 'right' });

    // Table starts below whichever section is taller
    const tableTop = Math.max(y + 14, adY + 34);

    // ── 3. Items table ────────────────────────────────────────────────────────
    const colW = { desc: W - 170, qty: 55, price: 58, amt: 57 };
    const colX = {
      desc:  L,
      qty:   L + colW.desc,
      price: L + colW.desc + colW.qty,
      amt:   L + colW.desc + colW.qty + colW.price,
    };

    const drawTableHeader = (yy) => {
      doc.rect(L, yy, W, 20).fill(blue);   // medium blue (not dark navy)
      doc.fillColor('#fff').fontSize(8.5).font('Helvetica-Bold');
      doc.text('Items',    colX.desc  + 6, yy + 6, { width: colW.desc  - 6 });
      doc.text('Quantity', colX.qty,        yy + 6, { width: colW.qty,   align: 'center' });
      doc.text('Price',    colX.price,      yy + 6, { width: colW.price, align: 'right' });
      doc.text('Amount',   colX.amt,        yy + 6, { width: colW.amt,   align: 'right' });
      return yy + 20;
    };

    let ty = drawTableHeader(tableTop);

    items.forEach((item, idx) => {
      const fullDesc = String(item.description || '');
      const descLines = fullDesc.split('\n').map(l => l.trim()).filter(Boolean);
      const title    = descLines[0] || '';
      const subLines = descLines.slice(1);
      const rowH     = Math.max(24, 14 + subLines.length * 12 + (subLines.length ? 6 : 0));

      // Pagination
      if (ty + rowH > doc.page.height - 120) {
        doc.addPage();
        ty = 40;
        ty = drawTableHeader(ty);
      }

      // Row separator (skip first)
      if (idx > 0) {
        doc.moveTo(L, ty).lineTo(R, ty).lineWidth(0.3).stroke(lineC);
      }

      // Item title — bold
      doc.fillColor(dark).fontSize(8.5).font('Helvetica-Bold')
         .text(title, colX.desc + 6, ty + 6, { width: colW.desc - 10 });

      // Sub-lines — muted smaller
      subLines.forEach((sub, si) => {
        doc.fillColor(muted).fontSize(7.5).font('Helvetica')
           .text(sub, colX.desc + 6, ty + 19 + si * 12, { width: colW.desc - 10 });
      });

      // Qty / Price / Amount — vertically centered
      const midY = ty + Math.floor(rowH / 2) - 4;
      doc.fillColor(dark).fontSize(8.5).font('Helvetica')
         .text(String(item.quantity || ''), colX.qty,   midY, { width: colW.qty,   align: 'center' });
      doc.text(`$${parseFloat(item.unit_price || 0).toFixed(2)}`, colX.price, midY, { width: colW.price, align: 'right' });
      doc.text(`$${parseFloat(item.subtotal   || 0).toFixed(2)}`, colX.amt,   midY, { width: colW.amt,   align: 'right' });

      ty += rowH;
    });

    // Bottom table border
    doc.moveTo(L, ty).lineTo(R, ty).lineWidth(0.5).stroke(lineC);

    // ── 4. Totals — right-aligned ─────────────────────────────────────────────
    ty += 14;
    const totX  = R - 230;
    const tLblW = 125;
    const tValW = 95;
    const tax   = parseFloat(inv.tax || 0);

    if (tax > 0) {
      // Show Subtotal + Tax when tax is non-zero
      doc.fillColor(muted).fontSize(8.5).font('Helvetica')
         .text('Subtotal:', totX, ty, { width: tLblW, align: 'right' });
      doc.fillColor(dark).fontSize(8.5).font('Helvetica')
         .text(`$${parseFloat(inv.subtotal || 0).toFixed(2)}`, totX + tLblW, ty, { width: tValW, align: 'right' });
      ty += 14;
      doc.fillColor(muted).fontSize(8.5).font('Helvetica')
         .text('Tax:', totX, ty, { width: tLblW, align: 'right' });
      doc.fillColor(dark).fontSize(8.5).font('Helvetica')
         .text(`$${tax.toFixed(2)}`, totX + tLblW, ty, { width: tValW, align: 'right' });
      ty += 14;
    } else {
      // No tax — just show Total
      doc.fillColor(muted).fontSize(8.5).font('Helvetica')
         .text('Total:', totX, ty, { width: tLblW, align: 'right' });
      doc.fillColor(dark).fontSize(8.5).font('Helvetica')
         .text(`$${parseFloat(inv.total || 0).toFixed(2)}`, totX + tLblW, ty, { width: tValW, align: 'right' });
      ty += 14;
    }

    doc.moveTo(totX, ty).lineTo(R, ty).lineWidth(0.8).stroke(lineC);
    ty += 8;

    doc.fillColor(navy).fontSize(9.5).font('Helvetica-Bold')
       .text('Amount Due (USD):', totX, ty, { width: tLblW, align: 'right' });
    doc.fillColor(navy).fontSize(10).font('Helvetica-Bold')
       .text(`$${parseFloat(inv.total || 0).toFixed(2)}`, totX + tLblW, ty, { width: tValW, align: 'right' });
    ty += 28;

    // ── 5. Notes (optional) ───────────────────────────────────────────────────
    if (inv.notes) {
      if (ty + 50 > doc.page.height - 80) { doc.addPage(); ty = 40; }
      doc.moveTo(L, ty).lineTo(R, ty).lineWidth(0.3).stroke(lineC);
      ty += 10;
      doc.fillColor(navy).fontSize(8).font('Helvetica-Bold').text('NOTES', L, ty);
      ty += 13;
      doc.fillColor(muted).fontSize(8.5).font('Helvetica').text(inv.notes, L, ty, { width: W });
    }

    // ── 6. Footer ─────────────────────────────────────────────────────────────
    const fY = doc.page.height - 45;
    doc.moveTo(L, fY - 6).lineTo(R, fY - 6).lineWidth(0.5).stroke(lineC);
    doc.fillColor(muted).fontSize(8).font('Helvetica')
       .text('Thank you for your business! — ABC Midwest Cleaning Services LLC', L, fY, { align: 'center', width: W });

    doc.end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
