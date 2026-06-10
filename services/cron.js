const cron = require('node-cron');
const { query } = require('../database');
const { sendAdminSummary } = require('./email');

// Current time as HH:MM (24h) in a given timezone
function currentHHMM(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const h = parts.find(p => p.type === 'hour').value;
    const m = parts.find(p => p.type === 'minute').value;
    return `${h === '24' ? '00' : h}:${m}`;
  } catch {
    // Fallback to UTC if timezone is invalid
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
  }
}

// Calendar date (YYYY-MM-DD) in a given timezone, with optional day offset
function getDateInTimezone(timezone, offsetDays = 0) {
  try {
    const d = new Date(Date.now() + offsetDays * 864e5);
    return d.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch {
    const d = new Date(Date.now() + offsetDays * 864e5);
    return d.toISOString().split('T')[0];
  }
}

// Get all active companies
async function getActiveCompanies() {
  const { rows } = await query(`SELECT id, name, timezone FROM companies WHERE active = TRUE`);
  return rows;
}

// Get notification settings for a company
async function getSettings(companyId) {
  const { rows } = await query(
    `SELECT key, value FROM notification_settings WHERE company_id = $1 AND key IN ('time_night','time_morning','time_midday')`,
    [companyId]
  );
  const s = { time_night: '20:00', time_morning: '08:00', time_midday: '12:00' };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

// Get active admin email recipients for a company
async function getAdminEmails(companyId) {
  const { rows } = await query(
    `SELECT email FROM admin_recipients WHERE company_id = $1 AND active = TRUE`,
    [companyId]
  );
  return rows.map(r => r.email);
}

// Get jobs for a date scoped to a company, with assigned employee names
async function getJobsWithEmployees(companyId, dateStr) {
  const { rows } = await query(`
    SELECT j.id, j.title, j.location, j.notes, j.start_time, j.end_time,
           COALESCE(
             ARRAY(
               SELECT u.name FROM users u WHERE u.id = ANY(j.assigned_to) ORDER BY u.name
             ), '{}'
           ) AS assigned_names
    FROM scheduled_jobs j
    WHERE j.company_id = $1 AND j.scheduled_date = $2
    ORDER BY j.start_time NULLS LAST, j.title
  `, [companyId, dateStr]);
  return rows;
}

// Send admin summary for one company
async function runAdminSummary(company, dateStr, label) {
  const adminEmails = await getAdminEmails(company.id);
  if (!adminEmails.length) {
    console.log(`[Cron][${company.name}] ${label}: no admin recipients`);
    return;
  }
  const jobs = await getJobsWithEmployees(company.id, dateStr);
  if (!jobs.length) {
    console.log(`[Cron][${company.name}] ${label}: no jobs for ${dateStr}`);
    return;
  }
  await sendAdminSummary(jobs, dateStr, adminEmails, label, company.name);
  console.log(`[Cron][${company.name}] ${label} sent for ${dateStr} → ${adminEmails.join(', ')}`);
}

function initCron() {
  cron.schedule('* * * * *', async () => {
    try {
      const companies = await getActiveCompanies();

      for (const company of companies) {
        const tz       = company.timezone || 'America/Chicago';
        const hhmm     = currentHHMM(tz);
        const settings = await getSettings(company.id);
        const today    = getDateInTimezone(tz, 0);
        const tomorrow = getDateInTimezone(tz, 1);

        if (hhmm === settings.time_night) {
          console.log(`[Cron][${company.name}] → NIGHT reminder`);
          await runAdminSummary(company, tomorrow, 'Trabajos de mañana');
        }

        if (hhmm === settings.time_morning) {
          console.log(`[Cron][${company.name}] → MORNING reminder`);
          await runAdminSummary(company, today, 'Trabajos de hoy');
        }

        if (hhmm === settings.time_midday) {
          console.log(`[Cron][${company.name}] → MIDDAY reminder`);
          await runAdminSummary(company, today, 'Recordatorio del mediodía');
        }
      }
    } catch (err) {
      console.error('[Cron] Error:', err.message, err.stack);
    }
  });

  console.log('Cron initialized: email reminders running every minute (per-company timezones).');
}

module.exports = { initCron };
