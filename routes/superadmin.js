const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../database');
const { requireSuperAdmin } = require('../middleware/auth');

router.use(requireSuperAdmin);

// ── List all companies ─────────────────────────────────────────────────────────

router.get('/companies', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'admin')::int   AS admin_count,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'employee')::int AS employee_count
      FROM companies c
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Get single company ─────────────────────────────────────────────────────────

router.get('/companies/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Create company (with initial admin) ───────────────────────────────────────

router.post('/companies', async (req, res) => {
  try {
    const { name, slug, timezone, admin_name, admin_username, admin_password, admin_email } = req.body;
    if (!name || !slug || !admin_name || !admin_username || !admin_password) {
      return res.status(400).json({ error: 'name, slug, admin_name, admin_username and admin_password required' });
    }

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(cleanSlug)) {
      return res.status(400).json({ error: 'Invalid slug. Use lowercase letters, numbers and hyphens (3-50 chars).' });
    }

    const { rows: existing } = await query('SELECT id FROM companies WHERE slug = $1', [cleanSlug]);
    if (existing.length) return res.status(400).json({ error: 'Slug already taken' });

    const tz = timezone || 'America/Chicago';

    const result = await withTransaction(async client => {
      const { rows: co } = await client.query(
        `INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, $3) RETURNING id`,
        [name.trim(), cleanSlug, tz]
      );
      const companyId = co[0].id;

      await client.query(`
        INSERT INTO notification_settings (company_id, key, value) VALUES
          ($1, 'time_night',   '20:00'),
          ($1, 'time_morning', '08:00'),
          ($1, 'time_midday',  '12:00')
        ON CONFLICT (company_id, key) DO NOTHING
      `, [companyId]);

      const hash = bcrypt.hashSync(admin_password, 10);
      await client.query(
        `INSERT INTO users (company_id, name, username, password, role, email) VALUES ($1, $2, $3, $4, 'admin', $5)`,
        [companyId, admin_name.trim(), admin_username.trim(), hash, admin_email?.trim() || null]
      );

      return companyId;
    });

    res.status(201).json({ id: result, slug: cleanSlug });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Update company ─────────────────────────────────────────────────────────────

router.put('/companies/:id', async (req, res) => {
  try {
    const { name, slug, timezone, logo_url, active } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const { rows: existing } = await query(
      'SELECT id FROM companies WHERE slug = $1 AND id != $2',
      [cleanSlug, req.params.id]
    );
    if (existing.length) return res.status(400).json({ error: 'Slug already taken' });

    await query(
      `UPDATE companies SET name = $1, slug = $2, timezone = $3, logo_url = $4, active = $5 WHERE id = $6`,
      [name.trim(), cleanSlug, timezone || 'America/Chicago', logo_url || null, active !== false, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Delete (deactivate) company ────────────────────────────────────────────────

router.delete('/companies/:id', async (req, res) => {
  try {
    await query(`UPDATE companies SET active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Seed demo company ─────────────────────────────────────────────────────────

router.post('/seed-demo', async (req, res) => {
  const SLUG = 'midwest-clean-demo';

  try {
    const { rows: existing } = await query('SELECT id FROM companies WHERE slug = $1', [SLUG]);
    if (existing.length) {
      return res.json({ success: false, message: 'Demo company already exists — nothing to do. Delete it first to re-seed.' });
    }

    // ── Static seed data ────────────────────────────────────────────────────
    const STORES_DATA = [
      { name: 'Chicago Loop Office',        address: '30 W Monroe St, Chicago, IL 60603',       lat: 41.8812, lng: -87.6298 },
      { name: 'Wicker Park Apartments',     address: '1601 N Milwaukee Ave, Chicago, IL 60647',  lat: 41.9101, lng: -87.6719 },
      { name: 'Naperville Corporate Park',  address: '55 W Shuman Blvd, Naperville, IL 60563',   lat: 41.7855, lng: -88.1473 },
      { name: 'Schaumburg Business Center', address: '1700 E Golf Rd, Schaumburg, IL 60173',     lat: 42.0295, lng: -88.0661 },
      { name: 'Oak Park Townhomes',         address: '1010 Lake St, Oak Park, IL 60301',         lat: 41.8851, lng: -87.7993 },
    ];
    const EMPLOYEES_DATA = [
      { name: 'Maria Lopez',       username: 'maria_demo',   si: [0,1] },
      { name: 'Carlos Mendoza',    username: 'carlos_demo',  si: [0,2] },
      { name: 'Ana Rodriguez',     username: 'ana_demo',     si: [1,3] },
      { name: 'James Williams',    username: 'james_demo',   si: [2,4] },
      { name: 'Sandra Kim',        username: 'sandra_demo',  si: [0,3,4] },
      { name: 'Roberto Gutierrez', username: 'roberto_demo', si: [1,2] },
      { name: 'Lisa Johnson',      username: 'lisa_demo',    si: [3,4] },
      { name: 'Miguel Torres',     username: 'miguel_demo',  si: [0,1,2] },
    ];
    const EXTRA_PROJECTS = [
      { name: 'Deep Clean — Willis Tower',         lat: 41.8789, lng: -87.6359, addr: '233 S Wacker Dr, Chicago, IL 60606' },
      { name: 'Post-Construction — Fulton Market', lat: 41.8860, lng: -87.6505, addr: '900 W Fulton Market, Chicago, IL 60607' },
      { name: 'Move-Out Clean — Lincoln Park',     lat: 41.9242, lng: -87.6522, addr: '2001 N Clark St, Chicago, IL 60614' },
      { name: 'Office Turnover — River North',     lat: 41.8952, lng: -87.6345, addr: '350 W Hubbard St, Chicago, IL 60654' },
      { name: 'Holiday Deep Clean — Evanston',     lat: 42.0451, lng: -87.6877, addr: '1717 Ridge Ave, Evanston, IL 60201' },
    ];
    const JOB_TEMPLATES = [
      { title: 'Weekly Clean — Loop Office',      loc: 'Chicago Loop Office',         s: '08:00', e: '14:00' },
      { title: 'Move-Out Clean — Wicker Park',    loc: 'Wicker Park Apartments',      s: '09:00', e: '17:00' },
      { title: 'Monthly Deep Clean — Naperville', loc: 'Naperville Corporate Park',   s: '07:00', e: '15:00' },
      { title: 'Window Cleaning — Schaumburg',    loc: 'Schaumburg Business Center',  s: '08:00', e: '12:00' },
      { title: 'Post-Renovation — Oak Park',      loc: 'Oak Park Townhomes',          s: '10:00', e: '18:00' },
      { title: 'Emergency Clean — Loop Office',   loc: 'Chicago Loop Office',         s: '06:00', e: '10:00' },
      { title: 'Carpet Cleaning — Wicker Park',   loc: 'Wicker Park Apartments',      s: '09:00', e: '13:00' },
      { title: 'Office Sanitize — Naperville',    loc: 'Naperville Corporate Park',   s: '07:30', e: '15:30' },
      { title: 'Deep Clean — Schaumburg',         loc: 'Schaumburg Business Center',  s: '08:00', e: '16:00' },
      { title: 'Move-In Prep — Oak Park',         loc: 'Oak Park Townhomes',          s: '08:00', e: '14:00' },
    ];

    // ── Helpers ─────────────────────────────────────────────────────────────
    const jt = (base, d = 0.0015) => parseFloat((base + (Math.random() - 0.5) * d * 2).toFixed(7));
    const ds = dt => dt.toISOString().slice(0, 10);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const offsetDate = (base, days) => { const d = new Date(base); d.setDate(d.getDate() + days); return d; };
    const chicagoTs = (dateStr, h, m = 0) => {
      const mo = parseInt(dateStr.slice(5, 7));
      const utcOffset = (mo >= 3 && mo <= 11) ? 5 : 6;
      const [y, mo2, dy] = dateStr.split('-').map(Number);
      return new Date(Date.UTC(y, mo2 - 1, dy, h + utcOffset, m, 0)).toISOString();
    };

    const stats = await withTransaction(async client => {
      // Company
      const { rows: [co] } = await client.query(
        `INSERT INTO companies (name, slug, timezone) VALUES ($1,$2,'America/Chicago') RETURNING id`,
        ['Midwest Clean Pro', SLUG]
      );
      const cid = co.id;

      // Notification settings
      await client.query(
        `INSERT INTO notification_settings (company_id,key,value) VALUES ($1,'time_night','20:00'),($1,'time_morning','08:00'),($1,'time_midday','12:00') ON CONFLICT DO NOTHING`,
        [cid]
      );

      // Admin user
      const adminHash = bcrypt.hashSync('Demo2024!', 10);
      await client.query(
        `INSERT INTO users (company_id,name,username,password,role,email) VALUES ($1,'Demo Admin','admin.demo',$2,'admin','admin@midwestcleanpro.demo')`,
        [cid, adminHash]
      );

      // Employees
      const empHash = bcrypt.hashSync('Demo2024!', 10);
      const empIds = [];
      for (const e of EMPLOYEES_DATA) {
        const { rows: [u] } = await client.query(
          `INSERT INTO users (company_id,name,username,password,role) VALUES ($1,$2,$3,$4,'employee') RETURNING id`,
          [cid, e.name, e.username, empHash]
        );
        empIds.push(u.id);
      }

      // Stores
      const storeIds = [];
      for (const s of STORES_DATA) {
        const { rows: [st] } = await client.query(
          `INSERT INTO stores (company_id,name,address) VALUES ($1,$2,$3) RETURNING id`,
          [cid, s.name, s.address]
        );
        storeIds.push(st.id);
      }

      // User-store assignments + calendar access
      for (let ei = 0; ei < EMPLOYEES_DATA.length; ei++) {
        for (const si of EMPLOYEES_DATA[ei].si) {
          await client.query(`INSERT INTO user_stores (user_id,store_id) VALUES ($1,$2)`, [empIds[ei], storeIds[si]]);
        }
        await client.query(`INSERT INTO calendar_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [empIds[ei]]);
      }

      // Work records — last 30 days
      const today = new Date();
      const CI_H = [7,7,7,8,8,8,8,9];
      const CI_M = [0,15,30,0,15,30,45,0];
      const DURS = [7,7.5,8,8,8,8.5,9];
      let recCount = 0;

      for (let ago = 30; ago >= 1; ago--) {
        const d = offsetDate(today, -ago);
        const dow = d.getDay();
        const dateS = ds(d);

        for (let ei = 0; ei < EMPLOYEES_DATA.length; ei++) {
          if (dow === 0) continue;
          if (dow === 6 && Math.random() > 0.28) continue;
          if (Math.random() > 0.83) continue;

          const si = pick(EMPLOYEES_DATA[ei].si);
          const store = STORES_DATA[si];
          const idx = Math.floor(Math.random() * CI_H.length);
          const ciH = CI_H[idx], ciM = CI_M[idx];
          const dur = pick(DURS);
          const totalMin = ciH * 60 + ciM + dur * 60;
          const coH = Math.floor(totalMin / 60), coM = Math.round(totalMin % 60);

          const { rows: [rec] } = await client.query(
            `INSERT INTO work_records (company_id,user_id,store_id,clock_in,clock_out,date,clock_in_lat,clock_in_lng,clock_in_address,clock_out_lat,clock_out_lng,clock_out_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [cid, empIds[ei], storeIds[si], chicagoTs(dateS,ciH,ciM), chicagoTs(dateS,coH,coM), dateS,
             jt(store.lat), jt(store.lng), store.address, jt(store.lat), jt(store.lng), store.address]
          );
          await client.query(
            `INSERT INTO media (record_id,filename,original_name,mime_type,type,url) VALUES ($1,$2,'checkin.jpg','image/jpeg','clock_in',null)`,
            [rec.id, `demo_${String(rec.id).padStart(5,'0')}.jpg`]
          );
          recCount++;
        }
      }

      // Extra projects
      const projOff = [-24,-18,-13,-9,-5];
      for (let pi = 0; pi < EXTRA_PROJECTS.length; pi++) {
        const proj = EXTRA_PROJECTS[pi];
        const dateS = ds(offsetDate(today, projOff[pi]));
        const { rows: [rec] } = await client.query(
          `INSERT INTO work_records (company_id,user_id,project_name,clock_in,clock_out,date,clock_in_lat,clock_in_lng,clock_in_address,clock_out_lat,clock_out_lng,clock_out_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [cid, empIds[pi % EMPLOYEES_DATA.length], proj.name, chicagoTs(dateS,10), chicagoTs(dateS,18,30), dateS,
           jt(proj.lat), jt(proj.lng), proj.addr, jt(proj.lat), jt(proj.lng), proj.addr]
        );
        await client.query(
          `INSERT INTO media (record_id,filename,original_name,mime_type,type,url) VALUES ($1,$2,'project.jpg','image/jpeg','clock_in',null)`,
          [rec.id, `demo_proj_${pi+1}.jpg`]
        );
      }

      // Payroll (2 payments per employee)
      const payDates = [
        ds(new Date(today.getFullYear(), today.getMonth()-1, 15)),
        ds(new Date(today.getFullYear(), today.getMonth()-1, 28)),
      ];
      const baseAmt = [542.50,560.00,518.00,595.00,577.50,533.00,551.00,584.00];
      for (let ei = 0; ei < EMPLOYEES_DATA.length; ei++) {
        for (const pd of payDates) {
          const amt = (baseAmt[ei] + (Math.random()-0.5)*30).toFixed(2);
          await client.query(`INSERT INTO payroll (company_id,user_id,payment_date,amount) VALUES ($1,$2,$3,$4)`, [cid,empIds[ei],pd,amt]);
        }
      }

      // Scheduled jobs (10)
      const jobOff = [-14,-7,-3,-1,0,1,3,7,14,21];
      for (let ji = 0; ji < JOB_TEMPLATES.length; ji++) {
        const tpl = JOB_TEMPLATES[ji];
        const jds = ds(offsetDate(today, jobOff[ji]));
        const assigned = [...empIds].sort(()=>Math.random()-0.5).slice(0, 2+(ji%2));
        await client.query(
          `INSERT INTO scheduled_jobs (company_id,title,scheduled_date,assigned_to,location,notes,start_time,end_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [cid, tpl.title, jds, assigned, tpl.loc, 'Demo job.', tpl.s, tpl.e]
        );
      }

      // Rest days (12)
      const restOff = [-27,-20,-15,-10,-8,-6,-5,-3,-2,-1,4,7];
      for (let ri = 0; ri < restOff.length; ri++) {
        const ei = ri % EMPLOYEES_DATA.length;
        const rds = ds(offsetDate(today, restOff[ri]));
        try {
          await client.query(
            `INSERT INTO rest_days (company_id,user_id,date,store_ids,note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,date) DO NOTHING`,
            [cid, empIds[ei], rds, [storeIds[EMPLOYEES_DATA[ei].si[0]]], 'Scheduled rest day']
          );
        } catch (_) {}
      }

      return { company_id: cid, work_records: recCount };
    });

    res.json({
      success: true,
      message: `Demo company "Midwest Clean Pro" seeded! ${stats.work_records} work records created.`,
      login: { username: 'admin.demo', password: 'Demo2024!' },
      employee_password: 'Demo2024!',
    });

  } catch (err) {
    console.error('Seed demo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Global stats ───────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const [coRes, userRes, recordRes] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active FROM companies`),
      query(`SELECT COUNT(*) FILTER (WHERE role = 'admin')::int AS admins, COUNT(*) FILTER (WHERE role = 'employee')::int AS employees FROM users WHERE company_id IS NOT NULL`),
      query(`SELECT COUNT(*)::int AS total FROM work_records`)
    ]);
    res.json({
      companies: coRes.rows[0],
      users: userRes.rows[0],
      work_records: recordRes.rows[0].total
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
