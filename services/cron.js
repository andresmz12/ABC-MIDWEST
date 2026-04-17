const cron = require('node-cron');
const { query } = require('../database');
const { sendReminderEmail } = require('./email');
const { broadcastWhatsAppMessage } = require('./whatsapp');

function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildWhatsAppText(label, jobs) {
  const lines = [`🗓 *ABC Midwest — ${label}*\n`];
  for (const j of jobs) {
    lines.push(`• *${j.title}*${j.location ? ` — ${j.location}` : ''}`);
    if (j.notes) lines.push(`  📝 ${j.notes}`);
  }
  return lines.join('\n');
}

async function sendMorningReminder() {
  const today = toLocalDateString(new Date());
  const { rows: jobs } = await query(
    `SELECT * FROM scheduled_jobs
     WHERE COALESCE(reminder_date, scheduled_date) = $1 AND reminder_sent_morning = FALSE`,
    [today]
  );
  if (jobs.length) {
    await sendReminderEmail(`Jobs scheduled for TODAY (${today})`, jobs);
    await broadcastWhatsAppMessage(buildWhatsAppText(`Jobs for TODAY (${today})`, jobs));
    await query(
      `UPDATE scheduled_jobs SET reminder_sent_morning = TRUE
       WHERE COALESCE(reminder_date, scheduled_date) = $1`,
      [today]
    );
  }
}

async function sendNightReminder() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toLocalDateString(tomorrow);
  const { rows: jobs } = await query(
    `SELECT * FROM scheduled_jobs
     WHERE COALESCE(reminder_date, scheduled_date) = $1 AND reminder_sent_night = FALSE`,
    [tomorrowStr]
  );
  if (jobs.length) {
    await sendReminderEmail(`Jobs scheduled for TOMORROW (${tomorrowStr})`, jobs);
    await broadcastWhatsAppMessage(buildWhatsAppText(`Jobs for TOMORROW (${tomorrowStr})`, jobs));
    await query(
      `UPDATE scheduled_jobs SET reminder_sent_night = TRUE
       WHERE COALESCE(reminder_date, scheduled_date) = $1`,
      [tomorrowStr]
    );
  }
}

function initCron() {
  cron.schedule('0 8 * * *', async () => {
    try { await sendMorningReminder(); }
    catch (err) { console.error('Morning reminder cron error:', err.message); }
  });

  cron.schedule('0 20 * * *', async () => {
    try { await sendNightReminder(); }
    catch (err) { console.error('Night reminder cron error:', err.message); }
  });

  console.log('Cron jobs initialized: morning (8am) and night (8pm) reminders active.');
}

module.exports = { initCron };
