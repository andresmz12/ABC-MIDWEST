const sgMail = require('@sendgrid/mail');

function getClient() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) { console.warn('[Email] SENDGRID_API_KEY not set — emails disabled'); return null; }
  sgMail.setApiKey(key);
  return sgMail;
}

const FROM = process.env.SENDGRID_FROM_EMAIL || 'noreply@worktrack.app';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function baseTemplate(companyName, title, bodyHtml) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a56db;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">${esc(companyName)}</h2>
        <p style="margin:6px 0 0;opacity:.85;font-size:.9rem">${esc(title)}</p>
      </div>
      <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px">
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:12px;margin:0">${esc(companyName)} — automated reminder</p>
      </div>
    </div>`;
}

function jobCard(j) {
  const loc      = j.location   ? `<div style="color:#374151;font-size:.9rem;margin-top:4px">📍 <strong>Lugar:</strong> ${esc(j.location)}</div>` : '';
  const timeRange = (j.start_time || j.end_time)
    ? `<div style="color:#374151;font-size:.9rem;margin-top:4px">🕐 <strong>Horario:</strong> ${esc(j.start_time || '?')}${j.end_time ? ' — ' + esc(j.end_time) : ''}</div>`
    : '';
  const notes = j.notes ? `<div style="color:#6b7280;font-size:.85rem;margin-top:6px;font-style:italic">${esc(j.notes)}</div>` : '';
  return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:10px">
    <strong style="font-size:1rem">${esc(j.title)}</strong>
    ${loc}${timeRange}${notes}
  </div>`;
}

// ── Send reminder to a single employee ────────────────────────────────────────

async function sendEmployeeReminder(employee, jobs, label, dateStr, companyName) {
  const client = getClient();
  if (!client || !employee.email) return;

  const name = companyName || 'WorkTrack';
  const isToday  = !label.toLowerCase().includes('mañana');
  const dayLabel = isToday ? 'hoy' : 'mañana';
  const jobCards = jobs.map(jobCard).join('');

  const html = baseTemplate(name, `Recordatorio — ${esc(label)} (${esc(dateStr)})`, `
    <p style="margin-top:0">Hola <strong>${esc(employee.name)}</strong>,</p>
    <p>Tienes <strong>${jobs.length} trabajo${jobs.length !== 1 ? 's' : ''}</strong> programado${jobs.length !== 1 ? 's' : ''} para <strong>${dayLabel}</strong> (<strong>${esc(dateStr)}</strong>):</p>
    ${jobCards}
  `);

  try {
    await client.send({
      to:      employee.email,
      from:    FROM,
      subject: `[${name}] ${label} — ${dateStr}`,
      html
    });
    console.log(`[Email] Sent to ${employee.name} <${employee.email}>`);
  } catch (err) {
    console.error(`[Email] Failed for ${employee.email}:`, err.message);
  }
}

// ── Send daily admin summary ───────────────────────────────────────────────────

async function sendAdminSummary(jobs, dateStr, adminEmails, label, companyName) {
  if (!adminEmails.length) return;
  const client = getClient();
  if (!client) { console.warn('[Email] sendAdminSummary: no client (SENDGRID_API_KEY not set)'); return; }

  const name = companyName || 'WorkTrack';

  const jobCards = jobs.map(j => {
    const assigned = j.assigned_names && j.assigned_names.length
      ? `<div style="color:#374151;font-size:.9rem;margin-top:4px">👷 <strong>Empleados:</strong> ${j.assigned_names.map(esc).join(', ')}</div>`
      : '';
    const loc       = j.location   ? `<div style="color:#374151;font-size:.9rem;margin-top:4px">📍 <strong>Lugar:</strong> ${esc(j.location)}</div>` : '';
    const timeRange = (j.start_time || j.end_time)
      ? `<div style="color:#374151;font-size:.9rem;margin-top:4px">🕐 <strong>Horario:</strong> ${esc(j.start_time || '?')}${j.end_time ? ' — ' + esc(j.end_time) : ''}</div>`
      : '';
    const notes = j.notes ? `<div style="color:#6b7280;font-size:.85rem;margin-top:6px;font-style:italic">${esc(j.notes)}</div>` : '';
    return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:10px">
      <strong style="font-size:1rem">${esc(j.title)}</strong>
      ${loc}${timeRange}${assigned}${notes}
    </div>`;
  }).join('');

  const title   = label || 'Resumen diario';
  const subject = `[${name}] ${title} — ${dateStr}`;

  const html = baseTemplate(name, `${esc(title)} — ${esc(dateStr)}`, `
    <p style="margin-top:0">Trabajos programados para <strong>${esc(dateStr)}</strong> (${jobs.length} trabajo${jobs.length !== 1 ? 's' : ''}):</p>
    ${jobCards}
  `);

  await Promise.all(adminEmails.map(to =>
    client.send({ to, from: FROM, subject, html })
      .then(() => console.log(`[Email] Admin summary → ${to}`))
      .catch(err => console.error(`[Email] Admin summary FAILED for ${to}:`, err.message, JSON.stringify(err.response && err.response.body)))
  ));
}

module.exports = { sendEmployeeReminder, sendAdminSummary };
