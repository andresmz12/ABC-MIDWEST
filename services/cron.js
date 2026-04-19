const cron = require('node-cron');
const { query } = require('../database');
const { sendEmployeeReminder, sendAdminSummary } = require('./email');

// Current time in Chicago as HH:MM (24h). Handles CST/CDT automatically.
function currentHHMM() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  return `${h === '24' ? '00' : h}:${m}`;
}

// Calendar date in Chicago timezone (YYYY-MM-DD). offsetDays=1 → tomorrow Chicago time.
// Critical: at 8pm CST the UTC date is already the next day, so we must use Chicago date.
function getChicagoDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

async function getSettings() {
  const { rows } = await query(
    `SELECT key, value FROM notification_settings WHERE key IN ('time_night','time_morning','time_midday')`
  );
  const s = { time_night: '20:00', time_morning: '08:00', time_midday: '12:00' };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function getAdminEmails() {
  const { rows } = await query(`SELECT email FROM admin_recipients WHERE active = TRUE`);
  return rows.map(r => r.email);
}

// Returns all jobs for a date with assigned employee names (for admin summary)
async function getJobsWithEmployees(dateStr) {
  const { rows } = await query(`
    SELECT j.id, j.title, j.location, j.notes, j.start_time, j.end_time,
           COALESCE(
             ARRAY(
               SELECT u.name FROM users u WHERE u.id = ANY(j.assigned_to) ORDER BY u.name
             ), '{}'
           ) AS assigned_names
    FROM scheduled_jobs j
    WHERE j.scheduled_date = $1
    ORDER BY j.start_time NULLS LAST, j.title
  `, [dateStr]);
  return rows;
}

async function sendEmployeeReminders(dateStr, flag, label) {
  const { rows: pendingJobs } = await query(
    `SELECT id FROM scheduled_jobs WHERE scheduled_date = $1 AND ${flag} = FALSE`,
    [dateStr]
  );
  if (!pendingJobs.length) {
    console.log(`[Cron] ${label}: no pending jobs for ${dateStr}`);
    return;
  }

  const { rows: empRows } = await query(`
    SELECT u.id, u.name, u.email,
           json_agg(json_build_object(
             'id', j.id, 'title', j.title, 'scheduled_date', j.scheduled_date,
             'location', j.location, 'notes', j.notes, 'start_time', j.start_time, 'end_time', j.end_time
           ) ORDER BY j.start_time NULLS LAST, j.title) AS jobs
    FROM scheduled_jobs j
    JOIN users u ON u.id = ANY(j.assigned_to)
    WHERE j.scheduled_date = $1 AND j.${flag} = FALSE AND u.email IS NOT NULL AND u.email != ''
    GROUP BY u.id, u.name, u.email
  `, [dateStr]);

  if (empRows.length === 0) {
    console.log(`[Cron] ${label}: ${pendingJobs.length} job(s) found but no assigned employees with email — skipping flag update`);
    return;
  }

  await Promise.all(empRows.map(emp => sendEmployeeReminder(emp, emp.jobs, label, dateStr)));

  // Only mark as sent once emails have actually been attempted
  await query(
    `UPDATE scheduled_jobs SET ${flag} = TRUE WHERE scheduled_date = $1 AND ${flag} = FALSE`,
    [dateStr]
  );
  console.log(`[Cron] ${label}: marked ${pendingJobs.length} job(s) sent, emailed ${empRows.length} employee(s)`);
}

// Send admin summary for a given date with a label
async function runAdminSummary(dateStr, label) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) {
    console.log(`[Cron] Admin summary (${label}): no admin recipients configured`);
    return;
  }
  const jobs = await getJobsWithEmployees(dateStr);
  if (!jobs.length) {
    console.log(`[Cron] Admin summary (${label}): no jobs for ${dateStr}`);
    return;
  }
  await sendAdminSummary(jobs, dateStr, adminEmails, label);
  console.log(`[Cron] Admin summary (${label}) sent for ${dateStr} → ${adminEmails.join(', ')}`);
}

function initCron() {
  cron.schedule('* * * * *', async () => {
    try {
      const hhmm     = currentHHMM();
      const settings = await getSettings();
      const today    = getChicagoDate(0);
      const tomorrow = getChicagoDate(1);

      console.log(`[Cron] tick ${hhmm} | today=${today} tomorrow=${tomorrow} | night=${settings.time_night} morning=${settings.time_morning} midday=${settings.time_midday}`);

      if (hhmm === settings.time_night) {
        console.log('[Cron] → NIGHT reminder firing');
        await sendEmployeeReminders(tomorrow, 'reminder_sent_night', 'Trabajos de mañana');
        await runAdminSummary(tomorrow, 'Resumen de mañana');
      }

      if (hhmm === settings.time_morning) {
        console.log('[Cron] → MORNING reminder firing');
        await sendEmployeeReminders(today, 'reminder_sent_morning', 'Trabajos de hoy');
        await runAdminSummary(today, 'Resumen del día');
      }

      if (hhmm === settings.time_midday) {
        console.log('[Cron] → MIDDAY reminder firing');
        await sendEmployeeReminders(today, 'reminder_sent_midday', 'Recordatorio del mediodía');
        await runAdminSummary(today, 'Recordatorio mediodía');
      }
    } catch (err) {
      console.error('[Cron] Reminder error:', err.message, err.stack);
    }
  });

  console.log('Cron initialized: email reminders running every minute (America/Chicago time).');
}

module.exports = { initCron };
