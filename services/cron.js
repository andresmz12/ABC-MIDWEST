const cron = require('node-cron');
const { query } = require('../database');
const { sendReminderEmail } = require('./email');

function toLocalDateString(date) {
  // Return YYYY-MM-DD in local time
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function sendMorningReminder() {
  // Jobs scheduled for TODAY that haven't had their morning reminder sent
  const today = toLocalDateString(new Date());
  const { rows: jobs } = await query(
    `SELECT * FROM scheduled_jobs WHERE scheduled_date = $1 AND reminder_sent_morning = FALSE`,
    [today]
  );
  if (jobs.length) {
    await sendReminderEmail(`Jobs scheduled for TODAY (${today})`, jobs);
    await query(
      `UPDATE scheduled_jobs SET reminder_sent_morning = TRUE WHERE scheduled_date = $1`,
      [today]
    );
  }
}

async function sendNightReminder() {
  // Jobs scheduled for TOMORROW that haven't had their night reminder sent
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toLocalDateString(tomorrow);
  const { rows: jobs } = await query(
    `SELECT * FROM scheduled_jobs WHERE scheduled_date = $1 AND reminder_sent_night = FALSE`,
    [tomorrowStr]
  );
  if (jobs.length) {
    await sendReminderEmail(`Jobs scheduled for TOMORROW (${tomorrowStr})`, jobs);
    await query(
      `UPDATE scheduled_jobs SET reminder_sent_night = TRUE WHERE scheduled_date = $1`,
      [tomorrowStr]
    );
  }
}

function initCron() {
  // 8:00 AM daily — morning reminder for today's jobs
  cron.schedule('0 8 * * *', async () => {
    try { await sendMorningReminder(); }
    catch (err) { console.error('Morning reminder cron error:', err.message); }
  });

  // 8:00 PM daily — night reminder for tomorrow's jobs
  cron.schedule('0 20 * * *', async () => {
    try { await sendNightReminder(); }
    catch (err) { console.error('Night reminder cron error:', err.message); }
  });

  console.log('Cron jobs initialized: morning (8am) and night (8pm) reminders active.');
}

module.exports = { initCron };
