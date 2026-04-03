const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const query = (text, params) => pool.query(text, params);

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'employee')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      date TEXT NOT NULL,
      notes TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL REFERENCES work_records(id),
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('clock_in', 'clock_out')),
      url TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      payment_date TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, store_id)
    )
  `);

  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_in_lat NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_in_lng NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_out_lat NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_out_lng NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS project_name TEXT`);
  await pool.query(`ALTER TABLE work_records ALTER COLUMN store_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS force_logout BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_in_address TEXT`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_out_address TEXT`);

  // ── Scheduled Jobs (calendar) ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      assigned_to INTEGER[] DEFAULT '{}',
      location TEXT,
      notes TEXT,
      reminder_sent_night BOOLEAN DEFAULT FALSE,
      reminder_sent_morning BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Rest Days ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rest_days (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      store_ids INTEGER[] NOT NULL DEFAULT '{}',
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, date)
    )
  `);

  // ── Invoices ───────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date TEXT,
      po_number TEXT,
      client_name TEXT NOT NULL,
      client_address TEXT,
      client_email TEXT,
      items JSONB NOT NULL DEFAULT '[]',
      subtotal NUMERIC(10,2) DEFAULT 0,
      tax NUMERIC(10,2) DEFAULT 0,
      total NUMERIC(10,2) DEFAULT 0,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid')),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date TEXT`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_number TEXT`);

  // ── Invoice Clients Catalog ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_clients (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      address TEXT,
      email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Invoice Projects Catalog ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_projects (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      default_price NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Scheduled Jobs image attachments ──────────────────────────────────────
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}'`);

  // ── Calendar Access (employees allowed to view/edit calendar) ─────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (rows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      'INSERT INTO users (name, username, password, role) VALUES ($1, $2, $3, $4)',
      ['Administrator', 'admin', hash, 'admin']
    );
    console.log('Default admin created: username=admin (change password immediately)');
  }

  // Performance indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_user_id  ON work_records(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_store_id ON work_records(store_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_date     ON work_records(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_user_id       ON payroll(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rest_days_user_id     ON rest_days(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_date   ON scheduled_jobs(scheduled_date)`);
}

module.exports = { query, withTransaction, initDb };
