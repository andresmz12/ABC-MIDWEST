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

// Returns employees-by-jobs map for a date: [{ id, name, email, jobs: [...] }]
async function getEmployeeJobsForDate(dateStr) {
  const { rows } = await query(`
    SELECT u.id, u.name, u.email,
           json_agg(json_build_object(
             'id', j.id, 'title', j.title, 'scheduled_date', j.scheduled_date,
             'location', j.location, 'notes', j.notes, 'start_time', j.start_time, 'end_time', j.end_time
           ) ORDER BY j.start_time NULLS LAST, j.title) AS jobs
    FROM scheduled_jobs j
    JOIN users u ON u.id = ANY(j.assigned_to)
    WHERE j.scheduled_date = $1
    GROUP BY u.id, u.name, u.email
  `, [dateStr]);
  return rows;
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
  // Find jobs that haven't had this reminder sent
  const { rows: pendingJobs } = await query(
    `SELECT id FROM scheduled_jobs WHERE scheduled_date = $1 AND ${flag} = FALSE`,
    [dateStr]
  );
  if (!pendingJobs.length) return;

  // Get employee→jobs map
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

  // Send individual emails
  await Promise.all(empRows.map(emp => sendEmployeeReminder(emp, emp.jobs, label, dateStr)));

  // Mark all pending jobs as sent
  await query(
    `UPDATE scheduled_jobs SET ${flag} = TRUE WHERE scheduled_date = $1 AND ${flag} = FALSE`,
    [dateStr]
  );
}

async function runMorningAdminSummary(dateStr) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) return;
  const jobs = await getJobsWithEmployees(dateStr);
  if (!jobs.length) return;
  await sendAdminSummary(jobs, dateStr, adminEmails);
}

function initCron() {
  cron.schedule('* * * * *', async () => {
    try {
      const hhmm    = currentHHMM();
      const settings = await getSettings();
      const today    = getChicagoDate(0);
      const tomorrow = getChicagoDate(1);

      if (hhmm === settings.time_night) {
        await sendEmployeeReminders(tomorrow, 'reminder_sent_night', 'Trabajos de mañana');
      }

      if (hhmm === settings.time_morning) {
        await sendEmployeeReminders(today, 'reminder_sent_morning', 'Trabajos de hoy');
        await runMorningAdminSummary(today);
      }

      if (hhmm === settings.time_midday) {
        await sendEmployeeReminders(today, 'reminder_sent_midday', 'Recordatorio del mediodía');
      }
    } catch (err) {
      console.error('[Cron] Reminder error:', err.message);
    }
  });

  console.log('Cron initialized: email reminders running every minute.');
}

module.exports = { initCron };
