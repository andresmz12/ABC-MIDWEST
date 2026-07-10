const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Parse PostgreSQL NUMERIC as JS number (default is string)
types.setTypeParser(1700, parseFloat);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: process.env.DB_SSL_VERIFY_CERT === 'true' } : false
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
  // ── Companies ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      logo_url TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Chicago',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Users ──────────────────────────────────────────────────────────────────
  // Fresh install: create with new schema. Existing install: ALTER TABLE below.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'employee')),
      email TEXT,
      force_logout BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Stores ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Work Records ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_records (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      store_id INTEGER REFERENCES stores(id),
      project_name TEXT,
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      date TEXT NOT NULL,
      notes TEXT,
      clock_in_lat NUMERIC(10,7),
      clock_in_lng NUMERIC(10,7),
      clock_out_lat NUMERIC(10,7),
      clock_out_lng NUMERIC(10,7),
      clock_in_address TEXT,
      clock_out_address TEXT
    )
  `);

  // ── Media ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      record_id INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('clock_in', 'clock_out')),
      url TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Payroll ────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      payment_date TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── User Stores (junction) ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, store_id)
    )
  `);

  // ── Scheduled Jobs ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      assigned_to INTEGER[] DEFAULT '{}',
      location TEXT,
      notes TEXT,
      start_time TEXT,
      end_time TEXT,
      image_urls TEXT[] DEFAULT '{}',
      reminder_sent_night BOOLEAN DEFAULT FALSE,
      reminder_sent_morning BOOLEAN DEFAULT FALSE,
      reminder_sent_midday BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Rest Days ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rest_days (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      store_ids INTEGER[] NOT NULL DEFAULT '{}',
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, date)
    )
  `);

  // ── Admin Email Recipients ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_recipients (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      label TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Notification Settings ──────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (company_id, key)
    )
  `);

  // ── Calendar Access ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // ── Breaks ────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS breaks (
      id SERIAL PRIMARY KEY,
      work_record_id INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      end_time TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Rest Day Requests ──────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rest_day_requests (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, date)
    )
  `);

  // ── Legacy Invoice tables (kept for data safety) ───────────────────────────
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
  await pool.query(`CREATE TABLE IF NOT EXISTS invoice_clients (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, address TEXT, email TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS invoice_projects (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, default_price NUMERIC(10,2) DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`);

  // ── Phase 1: Add missing columns (all nullable, no constraints yet) ──────────

  // company_id columns — added as nullable so existing rows don't break
  await pool.query(`ALTER TABLE users               ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE stores              ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE work_records        ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE scheduled_jobs      ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE rest_days           ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE payroll             ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE admin_recipients    ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await pool.query(`ALTER TABLE invoices             ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Other legacy columns
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_in_lat NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_in_lng NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_out_lat NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_out_lng NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS project_name TEXT`);
  await pool.query(`ALTER TABLE work_records ALTER COLUMN store_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS force_logout BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_in_address TEXT`);
  await pool.query(`ALTER TABLE work_records ADD COLUMN IF NOT EXISTS clock_out_address TEXT`);
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}'`);
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS reminder_sent_night BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS reminder_sent_morning BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS reminder_sent_midday BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS start_time TEXT`);
  await pool.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS end_time TEXT`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date TEXT`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_number TEXT`);

  // Fix role CHECK constraint to include super_admin
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('super_admin', 'admin', 'employee'));
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  // Drop old single-column constraints that will be replaced after data migration
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE admin_recipients DROP CONSTRAINT IF EXISTS admin_recipients_email_key;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  // ── Phase 2: Bootstrap default company ────────────────────────────────────

  const { rows: existingCompanies } = await pool.query('SELECT id FROM companies LIMIT 1');
  let defaultCompanyId;
  if (existingCompanies.length === 0) {
    const { rows: newCo } = await pool.query(
      `INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, $3) RETURNING id`,
      ['My Company', 'my-company', 'America/Chicago']
    );
    defaultCompanyId = newCo[0].id;
    console.log(`Default company created with id=${defaultCompanyId}`);
  } else {
    defaultCompanyId = existingCompanies[0].id;
  }

  // ── Phase 3: Populate company_id data (must happen before adding constraints) ─

  await pool.query(`UPDATE users               SET company_id = $1 WHERE company_id IS NULL AND role != 'super_admin'`, [defaultCompanyId]);
  await pool.query(`UPDATE stores              SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE work_records        SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE scheduled_jobs      SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE rest_days           SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE payroll             SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE admin_recipients    SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE notification_settings SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
  await pool.query(`UPDATE invoices             SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);

  // Seed default notification settings for the default company
  await pool.query(`
    INSERT INTO notification_settings (company_id, key, value) VALUES
      ($1, 'time_night',   '20:00'),
      ($1, 'time_morning', '08:00'),
      ($1, 'time_midday',  '12:00')
    ON CONFLICT DO NOTHING
  `, [defaultCompanyId]);

  // ── Phase 4: Add constraints now that data is populated ───────────────────

  // Add FK references (safe — data already populated)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_company_id_fkey' AND conrelid = 'users'::regclass) THEN
        ALTER TABLE users ADD CONSTRAINT users_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_company_id_fkey' AND conrelid = 'stores'::regclass) THEN
        ALTER TABLE stores ADD CONSTRAINT stores_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_records_company_id_fkey' AND conrelid = 'work_records'::regclass) THEN
        ALTER TABLE work_records ADD CONSTRAINT work_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_company_id_fkey' AND conrelid = 'scheduled_jobs'::regclass) THEN
        ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rest_days_company_id_fkey' AND conrelid = 'rest_days'::regclass) THEN
        ALTER TABLE rest_days ADD CONSTRAINT rest_days_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_company_id_fkey' AND conrelid = 'payroll'::regclass) THEN
        ALTER TABLE payroll ADD CONSTRAINT payroll_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_recipients_company_id_fkey' AND conrelid = 'admin_recipients'::regclass) THEN
        ALTER TABLE admin_recipients ADD CONSTRAINT admin_recipients_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_settings_company_id_fkey' AND conrelid = 'notification_settings'::regclass) THEN
        ALTER TABLE notification_settings ADD CONSTRAINT notification_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  // Fix notification_settings PK to (company_id, key) — safe now that data is populated
  await pool.query(`
    DO $$
    DECLARE
      old_pk text;
    BEGIN
      SELECT conname INTO old_pk
      FROM pg_constraint
      WHERE conrelid = 'notification_settings'::regclass AND contype = 'p'
        AND conname NOT LIKE '%company_id%';
      -- Only re-create if old PK exists and doesn't include company_id
      IF old_pk IS NOT NULL THEN
        EXECUTE 'ALTER TABLE notification_settings DROP CONSTRAINT ' || quote_ident(old_pk);
        ALTER TABLE notification_settings ADD PRIMARY KEY (company_id, key);
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  // Add (company_id, email) unique constraint on admin_recipients
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'admin_recipients'::regclass
          AND conname = 'admin_recipients_company_email_key'
      ) THEN
        ALTER TABLE admin_recipients ADD CONSTRAINT admin_recipients_company_email_key
          UNIQUE (company_id, email);
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `);

  // Per-company unique username indexes (replaces old global unique constraint)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_per_company
      ON users(company_id, username)
      WHERE company_id IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_super_admin
      ON users(username)
      WHERE company_id IS NULL
  `);

  // Create super admin if none exists
  const { rows: superAdmins } = await pool.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  if (superAdmins.length === 0) {
    const hash = bcrypt.hashSync('superadmin123', 10);
    await pool.query(
      `INSERT INTO users (name, username, password, role, company_id) VALUES ($1, $2, $3, $4, NULL)`,
      ['Super Admin', 'superadmin', hash, 'super_admin']
    );
    console.log('Super admin created: username=superadmin password=superadmin123 (change immediately)');
  }

  // Create default admin for the default company if none exists
  const { rows: admins } = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' AND company_id = $1 LIMIT 1`,
    [defaultCompanyId]
  );
  if (admins.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      `INSERT INTO users (company_id, name, username, password, role) VALUES ($1, $2, $3, $4, $5)`,
      [defaultCompanyId, 'Administrator', 'admin', hash, 'admin']
    );
    console.log('Default admin created: username=admin (change password immediately)');
  }

  // ── Performance indexes ────────────────────────────────────────────────────
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_company_id ON work_records(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_user_id    ON work_records(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_store_id   ON work_records(store_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_records_date       ON work_records(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_company_id      ON payroll(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_user_id         ON payroll(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rest_days_company_id    ON rest_days(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rest_days_user_id       ON rest_days(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_company  ON scheduled_jobs(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_date     ON scheduled_jobs(scheduled_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stores_company_id       ON stores(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_company_id        ON users(company_id)`);

  // ── Documents ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('insurance','irs','contract','license','hr','other')),
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      url           TEXT,
      size          INTEGER,
      uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_documents_company_id ON documents(company_id)`);

  // ── Geofencing for auto arrival detection ───────────────────────────────────
  // Add columns to stores for geolocation and working hours
  await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7)`);
  await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS opening_time TIME`);
  await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS closing_time TIME`);

  // Store real-time employee locations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_locations (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      lat NUMERIC(10,7) NOT NULL,
      lng NUMERIC(10,7) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Pending store locations proposed by employees
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_store_locations (
      id SERIAL PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      latitude NUMERIC(10,7) NOT NULL,
      longitude NUMERIC(10,7) NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Ensure only one pending location per store
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_store_locations_unique
    ON pending_store_locations(store_id) WHERE status='pending'
  `);

  // Log of auto-detected arrivals/departures
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arrival_events (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      event_type TEXT CHECK(event_type IN ('arrival', 'departure')),
      distance_meters INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_employee_locations_company_id ON employee_locations(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_store_locations_store_id ON pending_store_locations(store_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_arrival_events_company_id ON arrival_events(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_arrival_events_user_id ON arrival_events(user_id)`);
}

module.exports = { query, withTransaction, initDb };
