const router = require('express').Router();
const ExcelJS = require('exceljs');
const { query } = require('../database');
const { requireAdmin } = require('../middleware/auth');

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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
