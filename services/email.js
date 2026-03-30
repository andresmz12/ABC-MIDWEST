const nodemailer = require('nodemailer');

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('WARNING: SMTP credentials not configured. Email reminders are disabled.');
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendReminderEmail(subject, jobs) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) {
    console.warn('WARNING: ADMIN_EMAIL not set. Skipping reminder email.');
    return;
  }
  const transport = createTransport();
  if (!transport) return;

  const jobLines = jobs.map(j => {
    const loc = j.location ? ` — ${j.location}` : '';
    const notes = j.notes ? `<br><em style="color:#666">${j.notes}</em>` : '';
    return `<li><strong>${j.title}</strong>${loc}${notes}</li>`;
  }).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a56db;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">ABC Midwest — Job Reminder</h2>
      </div>
      <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px">
        <p style="margin-top:0">${subject}</p>
        <ul style="padding-left:20px;line-height:1.8">${jobLines}</ul>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:13px;margin:0">
          ABC Midwest Cleaning App — automated reminder
        </p>
      </div>
    </div>
  `;

  try {
    await transport.sendMail({
      from: `"ABC Midwest" <${process.env.SMTP_USER}>`,
      to,
      subject: `[ABC Midwest] ${subject}`,
      html
    });
    console.log(`Reminder email sent: "${subject}" (${jobs.length} job(s))`);
  } catch (err) {
    console.error('Failed to send reminder email:', err.message);
  }
}

module.exports = { sendReminderEmail };
