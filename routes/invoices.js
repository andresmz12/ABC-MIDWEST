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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Invoice Clients Catalog ────────────────────────────────────────────────────
router.get('/invoice-clients', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoice_clients ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/invoice-clients/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoice_clients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Invoice Projects Catalog ───────────────────────────────────────────────────
router.get('/invoice-projects', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoice_projects ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/invoice-projects/:id', async (req, res) => {
  try {
    await query('DELETE FROM invoice_projects WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const { invoice_number, invoice_date, due_date, po_number,
            client_name, client_address, client_email,
            items, tax, notes } = req.body;
    if (!invoice_number || !invoice_date || !client_name) {
      return res.status(400).json({ error: 'invoice_number, invoice_date and client_name are required' });
    }
    const parsedItems = Array.isArray(items) ? items : [];
    const subtotal = parsedItems.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    const taxAmt   = parseFloat(tax) || 0;
    const total    = subtotal + taxAmt;

    const { rows } = await query(
      `INSERT INTO invoices (invoice_number, invoice_date, due_date, po_number,
        client_name, client_address, client_email, items, subtotal, tax, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [invoice_number, invoice_date, due_date || null, po_number || null,
       client_name, client_address || null, client_email || null,
       JSON.stringify(parsedItems), subtotal, taxAmt, total, notes || null]
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
    const { invoice_number, invoice_date, due_date, po_number,
            client_name, client_address, client_email,
            items, tax, notes } = req.body;
    if (!invoice_number || !invoice_date || !client_name) {
      return res.status(400).json({ error: 'invoice_number, invoice_date and client_name are required' });
    }
    const parsedItems = Array.isArray(items) ? items : [];
    const subtotal = parsedItems.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    const taxAmt   = parseFloat(tax) || 0;
    const total    = subtotal + taxAmt;

    await query(
      `UPDATE invoices SET invoice_number=$1, invoice_date=$2, due_date=$3, po_number=$4,
        client_name=$5, client_address=$6, client_email=$7,
        items=$8, subtotal=$9, tax=$10, total=$11, notes=$12
       WHERE id=$13`,
      [invoice_number, invoice_date, due_date || null, po_number || null,
       client_name, client_address || null, client_email || null,
       JSON.stringify(parsedItems), subtotal, taxAmt, total,
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
    await query(`UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`, [req.params.id]);
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
    const inv   = rows[0];
    const items = Array.isArray(inv.items) ? inv.items : JSON.parse(inv.items || '[]');

    const doc = new PDFDocument({ margin: 40, size: 'LETTER', compress: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${inv.invoice_number}.pdf"`);
    doc.pipe(res);

    const blue    = '#1a56db';
    const dark    = '#111827';
    const muted   = '#6b7280';
    const lightBg = '#f3f4f6';
    const L       = 40;  // left margin
    const R       = doc.page.width - 40; // right edge
    const W       = R - L;  // usable width = 532

    // ── Header band ─────────────────────────────────────────────────────────
    doc.rect(L, 40, W, 64).fill(blue);

    // Logo (if present)
    const logoPath = path.join(__dirname, '..', 'public', 'images', 'logo.png');
    let logoEndX = L + 10;
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, L + 8, 46, { height: 50, fit: [50, 50] });
        logoEndX = L + 66;
      } catch (_) { logoEndX = L + 10; }
    }

    doc.fillColor('#fff').fontSize(15).font('Helvetica-Bold')
       .text('ABC Midwest Cleaning', logoEndX, 50, { width: 220 });
    doc.fontSize(8).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
       .text('Professional Cleaning Services', logoEndX, 68);

    // INVOICE label + number on right
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff')
       .text('INVOICE', L, 48, { align: 'right', width: W });
    doc.fontSize(9).font('Helvetica')
       .text(`#${inv.invoice_number}`, L, 73, { align: 'right', width: W });

    // ── Meta row (date / due / PO / status) ─────────────────────────────────
    let y = 116;
    // Left side: bill info
    doc.fillColor(blue).fontSize(8).font('Helvetica-Bold').text('BILL TO', L, y);
    doc.moveTo(L, y + 11).lineTo(L + 200, y + 11).lineWidth(0.5).stroke(blue);
    y += 16;
    doc.fillColor(dark).fontSize(10).font('Helvetica-Bold').text(inv.client_name, L, y);
    y += 14;
    if (inv.client_address) {
      doc.fontSize(8).font('Helvetica').fillColor(muted).text(inv.client_address, L, y, { width: 200 });
      y += 12 * (Math.ceil(inv.client_address.length / 40));
    }
    if (inv.client_email) {
      doc.fontSize(8).font('Helvetica').fillColor(muted).text(inv.client_email, L, y);
      y += 12;
    }

    // Right side: meta box
    const metaX = R - 190;
    let metaY = 116;
    const metaRows = [
      ['Invoice Date:', inv.invoice_date || ''],
      ['Due Date:',     inv.due_date || '–'],
      ['PO #:',         inv.po_number || '–'],
      ['Status:',       inv.status === 'paid' ? 'PAID' : 'PENDING'],
    ];
    doc.rect(metaX - 6, metaY - 4, 196, metaRows.length * 16 + 8).fill(lightBg);
    metaRows.forEach(([label, val], i) => {
      const ry = metaY + i * 16;
      doc.fillColor(muted).fontSize(8).font('Helvetica').text(label, metaX, ry, { width: 76 });
      const isStatus = label === 'Status:';
      doc.fillColor(isStatus ? (inv.status === 'paid' ? '#16a34a' : '#dc2626') : dark)
         .font(isStatus ? 'Helvetica-Bold' : 'Helvetica')
         .text(val, metaX + 80, ry, { width: 110 });
    });

    // ── Items table ───────────────────────────────────────────────────────────
    const tableTop = Math.max(y + 12, 116 + metaRows.length * 16 + 20);
    const colW = { desc: W - 180, qty: 40, price: 65, sub: 65 };
    const colX = {
      desc:  L,
      qty:   L + colW.desc,
      price: L + colW.desc + colW.qty,
      sub:   L + colW.desc + colW.qty + colW.price,
    };

    // Table header
    doc.rect(L, tableTop, W, 18).fill(dark);
    doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
    doc.text('Description', colX.desc + 4, tableTop + 5, { width: colW.desc - 4 });
    doc.text('Qty',   colX.qty,   tableTop + 5, { width: colW.qty,   align: 'right' });
    doc.text('Price', colX.price, tableTop + 5, { width: colW.price, align: 'right' });
    doc.text('Subtotal', colX.sub, tableTop + 5, { width: colW.sub,  align: 'right' });

    let ty = tableTop + 18;
    items.forEach((item, idx) => {
      // Estimate row height based on description length
      const descText = String(item.description || '');
      const lines    = Math.max(1, Math.ceil(doc.widthOfString(descText) / (colW.desc - 8)));
      const rowH     = Math.max(16, lines * 11 + 6);

      // New page if needed
      if (ty + rowH > doc.page.height - 120) {
        doc.addPage();
        ty = 40;
        // Re-draw table header on new page
        doc.rect(L, ty, W, 18).fill(dark);
        doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
        doc.text('Description', colX.desc + 4, ty + 5, { width: colW.desc - 4 });
        doc.text('Qty',   colX.qty,   ty + 5, { width: colW.qty,   align: 'right' });
        doc.text('Price', colX.price, ty + 5, { width: colW.price, align: 'right' });
        doc.text('Subtotal', colX.sub, ty + 5, { width: colW.sub,  align: 'right' });
        ty += 18;
      }

      if (idx % 2 === 0) doc.rect(L, ty, W, rowH).fill(lightBg);
      doc.fillColor(dark).fontSize(8.5).font('Helvetica');
      doc.text(descText, colX.desc + 4, ty + 4, { width: colW.desc - 8 });
      doc.text(String(item.quantity || 0), colX.qty, ty + 4, { width: colW.qty, align: 'right' });
      doc.text(`$${parseFloat(item.unit_price || 0).toFixed(2)}`, colX.price, ty + 4, { width: colW.price, align: 'right' });
      doc.text(`$${parseFloat(item.subtotal || 0).toFixed(2)}`,   colX.sub,   ty + 4, { width: colW.sub,   align: 'right' });
      ty += rowH;
    });

    doc.moveTo(L, ty).lineTo(R, ty).lineWidth(0.5).stroke('#e5e7eb');

    // ── Totals ────────────────────────────────────────────────────────────────
    ty += 8;
    const totX = R - 160;
    const totLW = 80;
    const totVW = 70;

    doc.fillColor(muted).fontSize(8.5).font('Helvetica');
    doc.text('Subtotal:', totX, ty, { width: totLW, align: 'right' });
    doc.fillColor(dark).text(`$${parseFloat(inv.subtotal || 0).toFixed(2)}`, totX + totLW, ty, { width: totVW, align: 'right' });
    ty += 14;
    doc.fillColor(muted).text('Tax:', totX, ty, { width: totLW, align: 'right' });
    doc.fillColor(dark).text(`$${parseFloat(inv.tax || 0).toFixed(2)}`, totX + totLW, ty, { width: totVW, align: 'right' });
    ty += 8;
    doc.moveTo(totX, ty).lineTo(R, ty).lineWidth(0.8).stroke(blue);
    ty += 6;
    doc.fillColor(blue).fontSize(11).font('Helvetica-Bold');
    doc.text('TOTAL:', totX, ty, { width: totLW, align: 'right' });
    doc.text(`$${parseFloat(inv.total || 0).toFixed(2)}`, totX + totLW, ty, { width: totVW, align: 'right' });
    ty += 22;

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (inv.notes) {
      if (ty + 40 > doc.page.height - 80) { doc.addPage(); ty = 40; }
      doc.rect(L, ty, W, 1).fill(lightBg);
      ty += 8;
      doc.fillColor(blue).fontSize(8).font('Helvetica-Bold').text('NOTES', L, ty);
      ty += 12;
      doc.fillColor(muted).fontSize(8.5).font('Helvetica').text(inv.notes, L, ty, { width: W });
      ty += doc.heightOfString(inv.notes, { width: W }) + 8;
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 45;
    doc.rect(L, footerY - 4, W, 0.5).fill('#e5e7eb');
    doc.fillColor(muted).fontSize(8).font('Helvetica')
       .text('Thank you for your business! — ABC Midwest Cleaning', L, footerY, { align: 'center', width: W });

    doc.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
