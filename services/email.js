const sgMail = require('@sendgrid/mail');

function getClient() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) { console.warn('[Email] SENDGRID_API_KEY not set — emails disabled'); return null; }
  sgMail.setApiKey(key);
  return sgMail;
}

const FROM = process.env.SENDGRID_FROM_EMAIL || 'andresmarinzapata@gmail.com';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function baseTemplate(title, bodyHtml) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a56db;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">🧹 ABC Midwest Cleaning</h2>
        <p style="margin:6px 0 0;opacity:.85;font-size:.9rem">${esc(title)}</p>
      </div>
      <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px">
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:12px;margin:0">ABC Midwest Cleaning App — automated reminder</p>
      </div>
    </div>`;
}

function jobCard(j) {
  const loc   = j.location ? `<div style="color:#6b7280;font-size:.88rem;margin-top:2px">📍 ${esc(j.location)}</div>` : '';
  const notes = j.notes    ? `<div style="color:#6b7280;font-size:.85rem;margin-top:4px;font-style:italic">${esc(j.notes)}</div>` : '';
  return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:10px">
    <strong style="font-size:.95rem">${esc(j.title)}</strong>
    ${loc}${notes}
  </div>`;
}

// ── Send reminder to a single employee ────────────────────────────────────────

async function sendEmployeeReminder(employee, jobs, label, dateStr) {
  const client = getClient();
  if (!client || !employee.email) return;

  const isToday    = !label.toLowerCase().includes('mañana');
  const greeting   = isToday ? 'Tienes trabajos programados para hoy' : 'Tienes trabajos programados para mañana';
  const jobCards   = jobs.map(jobCard).join('');

  const html = baseTemplate(`Recordatorio — ${esc(label)} (${esc(dateStr)})`, `
    <p style="margin-top:0">Hola <strong>${esc(employee.name)}</strong>,</p>
    <p>${greeting} (<strong>${esc(dateStr)}</strong>):</p>
    ${jobCards}
  `);

  const client2 = getClient();
  if (!client2) return;
  try {
    await client2.send({
      to:      employee.email,
      from:    FROM,
      subject: `[ABC Midwest] ${label} — ${dateStr}`,
      html
    });
    console.log(`[Email] Sent to ${employee.name} <${employee.email}>`);
  } catch (err) {
    console.error(`[Email] Failed for ${employee.email}:`, err.message);
  }
}

// ── Send daily admin summary ───────────────────────────────────────────────────

async function sendAdminSummary(jobs, dateStr, adminEmails) {
  if (!adminEmails.length) return;
  const client = getClient();
  if (!client) return;

  const jobCards = jobs.map(j => {
    const assigned = j.assigned_names && j.assigned_names.length
      ? `<div style="color:#6b7280;font-size:.85rem;margin-top:4px">👷 ${j.assigned_names.map(esc).join(', ')}</div>`
      : '';
    const loc   = j.location ? `<div style="color:#6b7280;font-size:.88rem;margin-top:2px">📍 ${esc(j.location)}</div>` : '';
    const notes = j.notes    ? `<div style="color:#6b7280;font-size:.85rem;margin-top:4px;font-style:italic">${esc(j.notes)}</div>` : '';
    return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:10px">
      <strong style="font-size:.95rem">${esc(j.title)}</strong>
      ${loc}${assigned}${notes}
    </div>`;
  }).join('');

  const html = baseTemplate(`Resumen diario — ${esc(dateStr)}`, `
    <p style="margin-top:0">Trabajos programados para <strong>${esc(dateStr)}</strong> (${jobs.length} trabajo${jobs.length !== 1 ? 's' : ''}):</p>
    ${jobCards}
  `);

  await Promise.all(adminEmails.map(to =>
    client.send({ to, from: FROM, subject: `[ABC Midwest] Resumen del día — ${dateStr}`, html })
      .then(() => console.log(`[Email] Admin summary → ${to}`))
      .catch(err => console.error(`[Email] Admin summary failed for ${to}:`, err.message))
  ));
}

module.exports = { sendEmployeeReminder, sendAdminSummary };
