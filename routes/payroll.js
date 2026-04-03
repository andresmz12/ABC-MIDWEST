const router = require('express').Router();
const ExcelJS = require('exceljs');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { query } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAdmin);

// ─── Register payment ──────────────────────────────────────────────────────────

router.post('/payroll', async (req, res) => {
  try {
    const { employee_id, payment_date, amount } = req.body;
    if (!employee_id || !payment_date || !amount) {
      return res.status(400).json({ error: 'Employee, date and amount required' });
    }
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const { rows: emp } = await query(
      "SELECT id FROM users WHERE id = $1 AND role = 'employee'",
      [employee_id]
    );
    if (!emp.length) return res.status(400).json({ error: 'Employee not found' });

    const { rows } = await query(
      'INSERT INTO payroll (user_id, payment_date, amount) VALUES ($1, $2, $3) RETURNING id',
      [employee_id, payment_date, parsed]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Payment history (filter by employee_id and/or year) ──────────────────────

router.get('/payroll', async (req, res) => {
  try {
    const { employee_id, year } = req.query;
    let sql = `
      SELECT p.id, u.name AS employee, u.id AS employee_id,
             p.payment_date, p.amount
      FROM payroll p
      JOIN users u ON u.id = p.user_id
      WHERE 1=1
    `;
    const params = [];
    let i = 1;
    if (employee_id) { sql += ` AND p.user_id = $${i++}`;                           params.push(employee_id); }
    if (year)        { sql += ` AND LEFT(p.payment_date, 4) = $${i++}`;              params.push(String(year)); }
    sql += ' ORDER BY p.payment_date DESC, u.name';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Annual summary per employee ───────────────────────────────────────────────

router.get('/payroll/summary', async (req, res) => {
  try {
    const year = String(req.query.year || new Date().getFullYear());
    const { rows } = await query(`
      SELECT u.id AS employee_id, u.name AS employee,
             COUNT(p.id)::int    AS payment_count,
             COALESCE(SUM(p.amount), 0) AS total
      FROM users u
      LEFT JOIN payroll p ON p.user_id = u.id AND LEFT(p.payment_date, 4) = $1
      WHERE u.role = 'employee'
      GROUP BY u.id, u.name
      ORDER BY u.name
    `, [year]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Export year to Excel ──────────────────────────────────────────────────────

router.get('/payroll/export', async (req, res) => {
  try {
    const year = String(req.query.year || new Date().getFullYear());
    const { rows } = await query(`
      SELECT u.name AS employee, p.payment_date, p.amount
      FROM payroll p
      JOIN users u ON u.id = p.user_id
      WHERE LEFT(p.payment_date, 4) = $1
      ORDER BY u.name, p.payment_date
    `, [year]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Payroll ${year}`);
    ws.columns = [
      { header: 'Employee',     key: 'employee',     width: 28 },
      { header: 'Payment Date', key: 'payment_date', width: 16 },
      { header: 'Amount',       key: 'amount',       width: 16 }
    ];
    rows.forEach(r => ws.addRow({
      employee:     r.employee,
      payment_date: r.payment_date,
      amount:       parseFloat(r.amount)
    }));
    ws.getRow(1).font = { bold: true };
    ws.getColumn('amount').numFmt = '"$"#,##0.00';

    res.setHeader('Content-Disposition', `attachment; filename="payroll_${year}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Import Payroll from Excel ─────────────────────────────────────────────────
// Excel format: columns Employee | Payment Date | Amount
router.post('/payroll/import', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Empty or invalid Excel file' });

    // Build employee name → id map (case-insensitive)
    const { rows: employees } = await query("SELECT id, name FROM users WHERE role = 'employee'");
    const empMap = {};
    employees.forEach(e => { empMap[e.name.toLowerCase()] = e.id; });

    const dataRows = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      const empName   = String(row.getCell(1).value ?? '').trim();
      const dateVal   = row.getCell(2).value;
      const amountVal = row.getCell(3).value;
      if (!empName && !dateVal && !amountVal) return; // skip blank rows
      dataRows.push({ rowNum, empName, dateVal, amountVal });
    });

    let imported = 0;
    const errors = [];

    for (const { rowNum, empName, dateVal, amountVal } of dataRows) {
      if (!empName)   { errors.push(`Row ${rowNum}: Employee name is required`); continue; }
      if (!dateVal)   { errors.push(`Row ${rowNum}: Payment date is required`);  continue; }
      if (!amountVal) { errors.push(`Row ${rowNum}: Amount is required`);        continue; }

      const empId = empMap[empName.toLowerCase()];
      if (!empId) { errors.push(`Row ${rowNum}: Employee "${empName}" not found`); continue; }

      // Normalise date to YYYY-MM-DD
      let dateStr;
      try {
        if (dateVal instanceof Date) {
          dateStr = dateVal.toISOString().split('T')[0];
        } else if (typeof dateVal === 'number') {
          // Excel serial date
          const d = new Date(Math.round((dateVal - 25569) * 86400000));
          dateStr = d.toISOString().split('T')[0];
        } else {
          const d = new Date(String(dateVal).trim());
          if (isNaN(d.getTime())) throw new Error(`Invalid date "${dateVal}"`);
          dateStr = d.toISOString().split('T')[0];
        }
      } catch (e) {
        errors.push(`Row ${rowNum}: ${e.message}`);
        continue;
      }

      const parsedAmount = parseFloat(amountVal);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        errors.push(`Row ${rowNum}: Invalid amount "${amountVal}"`);
        continue;
      }

      try {
        await query('INSERT INTO payroll (user_id, payment_date, amount) VALUES ($1, $2, $3)',
          [empId, dateStr, parsedAmount]);
        imported++;
      } catch (err) {
        console.error(err); errors.push(`Row ${rowNum}: import failed`);
      }
    }

    res.json({ imported, errors });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Scan Check Image (OCR) ────────────────────────────────────────────────────

function parseCheckText(text) {
  const amountMatches = text.match(/\$\s*([\d,]+\.?\d{0,2})/g) || [];
  const amounts = amountMatches.map(m => parseFloat(m.replace(/[$,\s]/g, '')));
  const amount = amounts.length ? Math.max(...amounts) : null;

  const dateMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  let checkDate = null;
  if (dateMatch) {
    const [, m, d, y] = dateMatch;
    const yr = y.length === 2 ? '20' + y : y;
    checkDate = `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const payeeMatch = text.match(/(?:pay\s+to\s+(?:the\s+order\s+of)?|order\s+of)\s*[:\*]?\s*([A-Za-z ,.'-]+)/i);
  const payee = payeeMatch ? payeeMatch[1].trim() : null;

  return { amount, checkDate, payee };
}

function matchEmployee(payeeName, employees) {
  if (!payeeName) return { employee: null, confidence: 'none' };
  const payee = payeeName.toLowerCase().trim();
  let m = employees.find(e =>
    e.name.toLowerCase().split(' ').every(w => w.length > 1 && payee.includes(w))
  );
  if (m) return { employee: m, confidence: 'high' };
  m = employees.find(e => {
    const words = payee.split(/\s+/).filter(w => w.length > 3);
    return words.some(w => e.name.toLowerCase().includes(w));
  });
  if (m) return { employee: m, confidence: 'low' };
  return { employee: null, confidence: 'none' };
}

router.post('/payroll/scan-check', memUpload.single('check'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'File must be an image' });
    }

    const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng', { logger: () => {} });
    const { amount, checkDate, payee } = parseCheckText(text);

    const { rows: employees } = await query("SELECT id, name FROM users WHERE role = 'employee' ORDER BY name");
    const { employee, confidence } = matchEmployee(payee, employees);

    res.json({
      payee_extracted: payee,
      amount,
      check_date: checkDate,
      matched_employee: employee ? { id: employee.id, name: employee.name } : null,
      confidence
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
