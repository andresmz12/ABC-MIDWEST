const cron = require('node-cron');
const { query } = require('../database');
const { sendReminderEmail } = require('./email');
const { sendSms } = require('./sms');

function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function currentHHMM() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

async function getSettings() {
  const { rows } = await query(`SELECT key, value FROM notification_settings WHERE key IN ('time_night','time_morning','time_midday')`);
  const s = { time_night: '20:00', time_morning: '08:00', time_midday: '12:00' };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function getActiveRecipients() {
  const { rows } = await query(`SELECT phone FROM sms_recipients WHERE active = TRUE`);
  return rows.map(r => r.phone);
}

function buildSmsBody(label, dateStr, jobs) {
  const lines = jobs.map(j => {
    let line = `• ${j.title}`;
    if (j.location) line += ` — ${j.location}`;
    if (j.notes)    line += `\n  ${j.notes}`;
    return line;
  });
  return `🧹 ABC Midwest\n📅 ${label} (${dateStr})\n\n${lines.join('\n\n')}`;
}

async function runReminder({ targetDate, flag, emailSubject, smsLabel }) {
  const { rows: jobs } = await query(
    `SELECT * FROM scheduled_jobs WHERE scheduled_date = $1 AND ${flag} = FALSE`,
    [targetDate]
  );
  if (!jobs.length) return;

  // Email
  await sendReminderEmail(emailSubject, jobs);

  // SMS to all active recipients
  const phones = await getActiveRecipients();
  if (phones.length) {
    const body = buildSmsBody(smsLabel, targetDate, jobs);
    await Promise.all(phones.map(phone => sendSms(phone, body)));
  }

  // Mark sent
  await query(`UPDATE scheduled_jobs SET ${flag} = TRUE WHERE scheduled_date = $1`, [targetDate]);
}

function initCron() {
  // Run every minute — checks configured times dynamically
  cron.schedule('* * * * *', async () => {
    try {
      const hhmm    = currentHHMM();
      const settings = await getSettings();
      const now      = new Date();

      const today    = toLocalDateString(now);
      const tmrw     = new Date(now); tmrw.setDate(now.getDate() + 1);
      const tomorrow = toLocalDateString(tmrw);

      if (hhmm === settings.time_night) {
        await runReminder({
          targetDate:   tomorrow,
          flag:         'reminder_sent_night',
          emailSubject: `Trabajos de mañana (${tomorrow})`,
          smsLabel:     'Trabajos de mañana'
        });
      }

      if (hhmm === settings.time_morning) {
        await runReminder({
          targetDate:   today,
          flag:         'reminder_sent_morning',
          emailSubject: `Trabajos de hoy (${today})`,
          smsLabel:     'Trabajos de hoy'
        });
      }

      if (hhmm === settings.time_midday) {
        await runReminder({
          targetDate:   today,
          flag:         'reminder_sent_midday',
          emailSubject: `Recordatorio del mediodía — trabajos de hoy (${today})`,
          smsLabel:     'Recordatorio del mediodía'
        });
      }
    } catch (err) {
      console.error('[Cron] Reminder error:', err.message);
    }
  });

  console.log('Cron initialized: reminder checks running every minute.');
}

module.exports = { initCron };
