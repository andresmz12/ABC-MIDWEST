const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const query = (text, params) => pool.query(text, params);

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

  const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (rows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      'INSERT INTO users (name, username, password, role) VALUES ($1, $2, $3, $4)',
      ['Administrator', 'admin', hash, 'admin']
    );
    console.log('Default admin created: username=admin, password=admin123');
  }
}

module.exports = { query, initDb };
