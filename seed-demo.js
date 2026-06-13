'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Static data ──────────────────────────────────────────────────────────────

const COMPANY = {
  name: 'Midwest Clean Pro',
  slug: 'midwest-clean-demo',
  timezone: 'America/Chicago',
};

const ADMIN = {
  name: 'Demo Admin',
  username: 'admin.demo',
  password: 'Demo2024!',
  email: 'admin@midwestcleanpro.demo',
};

const STORES = [
  { name: 'Chicago Loop Office',        address: '30 W Monroe St, Chicago, IL 60603',       lat: 41.8812, lng: -87.6298 },
  { name: 'Wicker Park Apartments',     address: '1601 N Milwaukee Ave, Chicago, IL 60647',  lat: 41.9101, lng: -87.6719 },
  { name: 'Naperville Corporate Park',  address: '55 W Shuman Blvd, Naperville, IL 60563',   lat: 41.7855, lng: -88.1473 },
  { name: 'Schaumburg Business Center', address: '1700 E Golf Rd, Schaumburg, IL 60173',     lat: 42.0295, lng: -88.0661 },
  { name: 'Oak Park Townhomes',         address: '1010 Lake St, Oak Park, IL 60301',         lat: 41.8851, lng: -87.7993 },
];

const EMPLOYEES = [
  { name: 'Maria Lopez',       username: 'maria_demo',   storeIdxs: [0, 1] },
  { name: 'Carlos Mendoza',    username: 'carlos_demo',  storeIdxs: [0, 2] },
  { name: 'Ana Rodriguez',     username: 'ana_demo',     storeIdxs: [1, 3] },
  { name: 'James Williams',    username: 'james_demo',   storeIdxs: [2, 4] },
  { name: 'Sandra Kim',        username: 'sandra_demo',  storeIdxs: [0, 3, 4] },
  { name: 'Roberto Gutierrez', username: 'roberto_demo', storeIdxs: [1, 2] },
  { name: 'Lisa Johnson',      username: 'lisa_demo',    storeIdxs: [3, 4] },
  { name: 'Miguel Torres',     username: 'miguel_demo',  storeIdxs: [0, 1, 2] },
];

const EXTRA_PROJECTS = [
  { name: 'Deep Clean — Willis Tower',         lat: 41.8789, lng: -87.6359, addr: '233 S Wacker Dr, Chicago, IL 60606' },
  { name: 'Post-Construction — Fulton Market', lat: 41.8860, lng: -87.6505, addr: '900 W Fulton Market, Chicago, IL 60607' },
  { name: 'Move-Out Clean — Lincoln Park',     lat: 41.9242, lng: -87.6522, addr: '2001 N Clark St, Chicago, IL 60614' },
  { name: 'Office Turnover — River North',     lat: 41.8952, lng: -87.6345, addr: '350 W Hubbard St, Chicago, IL 60654' },
  { name: 'Holiday Deep Clean — Evanston',     lat: 42.0451, lng: -87.6877, addr: '1717 Ridge Ave, Evanston, IL 60201' },
];

const JOB_TEMPLATES = [
  { title: 'Weekly Clean — Loop Office',      location: 'Chicago Loop Office',         start_time: '08:00', end_time: '14:00' },
  { title: 'Move-Out Clean — Wicker Park',    location: 'Wicker Park Apartments',      start_time: '09:00', end_time: '17:00' },
  { title: 'Monthly Deep Clean — Naperville', location: 'Naperville Corporate Park',   start_time: '07:00', end_time: '15:00' },
  { title: 'Window Cleaning — Schaumburg',    location: 'Schaumburg Business Center',  start_time: '08:00', end_time: '12:00' },
  { title: 'Post-Renovation — Oak Park',      location: 'Oak Park Townhomes',          start_time: '10:00', end_time: '18:00' },
  { title: 'Emergency Clean — Loop Office',   location: 'Chicago Loop Office',         start_time: '06:00', end_time: '10:00' },
  { title: 'Carpet Cleaning — Wicker Park',   location: 'Wicker Park Apartments',      start_time: '09:00', end_time: '13:00' },
  { title: 'Office Sanitize — Naperville',    location: 'Naperville Corporate Park',   start_time: '07:30', end_time: '15:30' },
  { title: 'Deep Clean — Schaumburg',         location: 'Schaumburg Business Center',  start_time: '08:00', end_time: '16:00' },
  { title: 'Move-In Prep — Oak Park',         location: 'Oak Park Townhomes',          start_time: '08:00', end_time: '14:00' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function jitter(base, delta = 0.0015) {
  return parseFloat((base + (Math.random() - 0.5) * delta * 2).toFixed(7));
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Build UTC timestamp for a given Chicago local time
// CDT (Mar–Nov) = UTC-5, CST (Dec–Feb) = UTC-6
function chicagoTs(ds, localHour, localMin = 0) {
  const m = parseInt(ds.slice(5, 7));
  const utcOffset = (m >= 3 && m <= 11) ? 5 : 6;
  const [y, mo, dy] = ds.split('-').map(Number);
  const ts = new Date(Date.UTC(y, mo - 1, dy, localHour + utcOffset, localMin, 0));
  return ts.toISOString();
}

function offsetDate(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();

  try {
    // Idempotency guard
    const existing = await client.query(
      'SELECT id FROM companies WHERE slug = $1', [COMPANY.slug]
    );
    if (existing.rows.length > 0) {
      console.log('ℹ️  Demo company already exists — nothing to seed. Delete it first to re-seed.');
      return;
    }

    await client.query('BEGIN');

    // ── 1. Company ────────────────────────────────────────────────────────────
    const coRes = await client.query(
      'INSERT INTO companies (name, slug, timezone) VALUES ($1,$2,$3) RETURNING id',
      [COMPANY.name, COMPANY.slug, COMPANY.timezone]
    );
    const cid = coRes.rows[0].id;
    console.log(`✅  Company created  id=${cid}  "${COMPANY.name}"`);

    // ── 2. Notification settings ──────────────────────────────────────────────
    await client.query(
      "INSERT INTO notification_settings (company_id,key,value) VALUES ($1,'time_night','20:00'),($1,'time_morning','08:00'),($1,'time_midday','12:00')",
      [cid]
    );

    // ── 3. Admin user ─────────────────────────────────────────────────────────
    const adminHash = bcrypt.hashSync(ADMIN.password, 10);
    await client.query(
      "INSERT INTO users (company_id,name,username,password,role,email) VALUES ($1,$2,$3,$4,'admin',$5)",
      [cid, ADMIN.name, ADMIN.username, adminHash, ADMIN.email]
    );
    console.log(`✅  Admin created    ${ADMIN.username} / ${ADMIN.password}`);

    // ── 4. Employees ──────────────────────────────────────────────────────────
    const empHash = bcrypt.hashSync('Demo2024!', 10);
    const empIds = [];
    for (const e of EMPLOYEES) {
      const r = await client.query(
        "INSERT INTO users (company_id,name,username,password,role) VALUES ($1,$2,$3,$4,'employee') RETURNING id",
        [cid, e.name, e.username, empHash]
      );
      empIds.push(r.rows[0].id);
    }
    console.log(`✅  ${EMPLOYEES.length} employees created`);

    // ── 5. Stores ─────────────────────────────────────────────────────────────
    const storeIds = [];
    for (const s of STORES) {
      const r = await client.query(
        'INSERT INTO stores (company_id,name,address) VALUES ($1,$2,$3) RETURNING id',
        [cid, s.name, s.address]
      );
      storeIds.push(r.rows[0].id);
    }
    console.log(`✅  ${STORES.length} stores created`);

    // ── 6. Employee → Store assignments ───────────────────────────────────────
    for (let ei = 0; ei < EMPLOYEES.length; ei++) {
      for (const si of EMPLOYEES[ei].storeIdxs) {
        await client.query(
          'INSERT INTO user_stores (user_id,store_id) VALUES ($1,$2)',
          [empIds[ei], storeIds[si]]
        );
      }
    }
    console.log('✅  Employee-store assignments done');

    // ── 7. Calendar access ────────────────────────────────────────────────────
    for (const uid of empIds) {
      await client.query(
        'INSERT INTO calendar_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]
      );
    }

    // ── 8. Work records — last 30 days ────────────────────────────────────────
    const today = new Date();
    const CI_HOURS = [7, 7, 7, 8, 8, 8, 8, 9];
    const CI_MINS  = [0,15,30, 0,15,30,45, 0];
    const DURS     = [7, 7.5, 8, 8, 8, 8.5, 9]; // hours
    let recordCount = 0;

    for (let ago = 30; ago >= 1; ago--) {
      const d = offsetDate(today, -ago);
      const dow = d.getDay(); // 0=Sun
      const ds = dateStr(d);

      for (let ei = 0; ei < EMPLOYEES.length; ei++) {
        if (dow === 0) continue;
        if (dow === 6 && Math.random() > 0.28) continue;
        if (Math.random() > 0.83) continue;

        const si = pick(EMPLOYEES[ei].storeIdxs);
        const store = STORES[si];
        const storeId = storeIds[si];

        const idx = Math.floor(Math.random() * CI_HOURS.length);
        const ciH = CI_HOURS[idx];
        const ciM = CI_MINS[idx];
        const dur = pick(DURS);
        const totalMin = ciH * 60 + ciM + dur * 60;
        const coH = Math.floor(totalMin / 60);
        const coM = Math.round(totalMin % 60);

        const ciTs = chicagoTs(ds, ciH, ciM);
        const coTs = chicagoTs(ds, coH, coM);

        const recRes = await client.query(
          `INSERT INTO work_records
             (company_id, user_id, store_id, clock_in, clock_out, date,
              clock_in_lat, clock_in_lng, clock_in_address,
              clock_out_lat, clock_out_lng, clock_out_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            cid, empIds[ei], storeId, ciTs, coTs, ds,
            jitter(store.lat), jitter(store.lng), store.address,
            jitter(store.lat), jitter(store.lng), store.address,
          ]
        );

        await client.query(
          `INSERT INTO media (record_id, filename, original_name, mime_type, type, url)
           VALUES ($1,$2,'checkin.jpg','image/jpeg','clock_in',null)`,
          [recRes.rows[0].id, `demo_checkin_${String(recRes.rows[0].id).padStart(5,'0')}.jpg`]
        );

        recordCount++;
      }
    }
    console.log(`✅  ${recordCount} work records created (last 30 days)`);

    // ── 9. Extra project records ──────────────────────────────────────────────
    const projOffsets = [-24, -18, -13, -9, -5];
    for (let pi = 0; pi < EXTRA_PROJECTS.length; pi++) {
      const proj = EXTRA_PROJECTS[pi];
      const ds = dateStr(offsetDate(today, projOffsets[pi]));
      const ei = pi % EMPLOYEES.length;
      const ciTs = chicagoTs(ds, 10, 0);
      const coTs = chicagoTs(ds, 18, 30);

      const rr = await client.query(
        `INSERT INTO work_records
           (company_id, user_id, project_name, clock_in, clock_out, date,
            clock_in_lat, clock_in_lng, clock_in_address,
            clock_out_lat, clock_out_lng, clock_out_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          cid, empIds[ei], proj.name, ciTs, coTs, ds,
          jitter(proj.lat), jitter(proj.lng), proj.addr,
          jitter(proj.lat), jitter(proj.lng), proj.addr,
        ]
      );
      await client.query(
        `INSERT INTO media (record_id, filename, original_name, mime_type, type, url)
         VALUES ($1,$2,'project.jpg','image/jpeg','clock_in',null)`,
        [rr.rows[0].id, `demo_project_${pi + 1}.jpg`]
      );
    }
    console.log(`✅  ${EXTRA_PROJECTS.length} extra project records created`);

    // ── 10. Payroll ───────────────────────────────────────────────────────────
    const payDates = [
      dateStr(new Date(today.getFullYear(), today.getMonth() - 1, 15)),
      dateStr(new Date(today.getFullYear(), today.getMonth() - 1, 28)),
    ];
    const baseAmounts = [542.50, 560.00, 518.00, 595.00, 577.50, 533.00, 551.00, 584.00];
    for (let ei = 0; ei < EMPLOYEES.length; ei++) {
      for (const pd of payDates) {
        const amt = (baseAmounts[ei] + (Math.random() - 0.5) * 30).toFixed(2);
        await client.query(
          'INSERT INTO payroll (company_id,user_id,payment_date,amount) VALUES ($1,$2,$3,$4)',
          [cid, empIds[ei], pd, amt]
        );
      }
    }
    console.log(`✅  ${EMPLOYEES.length * payDates.length} payroll records created`);

    // ── 11. Scheduled jobs ────────────────────────────────────────────────────
    const jobOffsets = [-14, -7, -3, -1, 0, 1, 3, 7, 14, 21];
    for (let ji = 0; ji < JOB_TEMPLATES.length; ji++) {
      const tpl = JOB_TEMPLATES[ji];
      const jds = dateStr(offsetDate(today, jobOffsets[ji]));
      const shuffled = [...empIds].sort(() => Math.random() - 0.5);
      const assigned = shuffled.slice(0, 2 + (ji % 2));
      await client.query(
        `INSERT INTO scheduled_jobs
           (company_id, title, scheduled_date, assigned_to, location, notes, start_time, end_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [cid, tpl.title, jds, assigned, tpl.location, 'Demo job.', tpl.start_time, tpl.end_time]
      );
    }
    console.log(`✅  ${JOB_TEMPLATES.length} scheduled jobs created`);

    // ── 12. Rest days ─────────────────────────────────────────────────────────
    const restOffsets = [-27, -20, -15, -10, -8, -6, -5, -3, -2, -1, 4, 7];
    let rdCount = 0;
    for (let ri = 0; ri < restOffsets.length; ri++) {
      const ei = ri % EMPLOYEES.length;
      const rds = dateStr(offsetDate(today, restOffsets[ri]));
      const si = EMPLOYEES[ei].storeIdxs[0];
      try {
        await client.query(
          `INSERT INTO rest_days (company_id, user_id, date, store_ids, note)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, date) DO NOTHING`,
          [cid, empIds[ei], rds, [storeIds[si]], 'Scheduled rest day']
        );
        rdCount++;
      } catch (_) { /* skip conflicts */ }
    }
    console.log(`✅  ${rdCount} rest days created`);

    await client.query('COMMIT');

    console.log('\n🎉  Demo seed complete!\n');
    console.log('  Company slug : midwest-clean-demo');
    console.log('  Admin login  : admin.demo  /  Demo2024!');
    console.log('  Employees    : maria_demo, carlos_demo, ana_demo, james_demo,');
    console.log('                 sandra_demo, roberto_demo, lisa_demo, miguel_demo');
    console.log('  Password     : Demo2024!\n');

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\n❌  Seed failed (rolled back):', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => process.exit(1));
