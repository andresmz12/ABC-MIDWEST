const TelegramBot = require('node-telegram-bot-api');
const { query } = require('../database');

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/[áàâä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i').replace(/[óòôö]/g, 'o')
    .replace(/[úùûü]/g, 'u').replace(/ñ/g, 'n');
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function weekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((day + 6) % 7));
  return { from: mon.toISOString().split('T')[0], to: today() };
}

function fmtHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ── Find employee by name mention in message ──────────────────────────────────

async function findEmployee(text) {
  const { rows } = await query("SELECT id, name FROM users WHERE role = 'employee' ORDER BY name");
  const norm = normalize(text);

  // High confidence: all name parts appear in message
  let match = rows.find(e =>
    normalize(e.name).split(' ').filter(w => w.length > 1).every(w => norm.includes(w))
  );
  if (match) return match;

  // Low confidence: any significant word (>3 chars) from name appears in message
  match = rows.find(e =>
    normalize(e.name).split(' ').filter(w => w.length > 3).some(w => norm.includes(w))
  );
  return match || null;
}

// ── Intent detection ──────────────────────────────────────────────────────────

function detectIntent(text) {
  const t = normalize(text);

  if (/ponch|entr[oó]|lleg[oó]|marc[oó]|clock|punch|chequ/.test(t))        return 'clock_in';
  if (/qui[eé]n.*trabaj|trabaj.*hoy|activ|trabajando|quienes/.test(t))       return 'who_working';
  if (/horas?.*(hoy|today)/.test(t))                                          return 'hours_today';
  if (/horas?|trabaj[oó]|semana|week|cuanto.*trabaj/.test(t))                 return 'hours_week';
  if (/descanso|libre|day.?off|off|vacacI/.test(t))                           return 'rest_day';
  if (/pag[oó]|pagad|salario|sueldo|payroll|cuanto.*deb|debe/.test(t))        return 'payroll';
  if (/ayuda|help|hola|hi|buenas|comandos|que puedes/.test(t))                return 'help';
  return 'unknown';
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function handleClockIn(emp) {
  const { rows } = await query(
    `SELECT clock_in, clock_out FROM work_records WHERE user_id=$1 AND date=$2 ORDER BY clock_in DESC LIMIT 1`,
    [emp.id, today()]
  );
  if (!rows.length) return `❌ <b>${esc(emp.name)}</b> no ha marcado entrada hoy.`;
  const r = rows[0];
  if (!r.clock_out) {
    return `✅ <b>${esc(emp.name)}</b> marcó entrada hoy a las <b>${esc(fmtTime(r.clock_in))}</b> y sigue activo.`;
  }
  return `✅ <b>${esc(emp.name)}</b> trabajó hoy: entrada ${esc(fmtTime(r.clock_in))} — salida ${esc(fmtTime(r.clock_out))}.`;
}

async function handleWhoWorking() {
  const { rows } = await query(`
    SELECT u.name, wr.clock_in, s.name AS store
    FROM work_records wr
    JOIN users u ON u.id = wr.user_id
    LEFT JOIN stores s ON s.id = wr.store_id
    WHERE wr.date = $1 AND wr.clock_out IS NULL
    ORDER BY u.name
  `, [today()]);

  if (!rows.length) return '📋 Nadie está trabajando actualmente.';
  const list = rows.map(r =>
    `• <b>${esc(r.name)}</b> (entrada: ${esc(fmtTime(r.clock_in))}${r.store ? `, ${esc(r.store)}` : ''})`
  ).join('\n');
  return `👷 <b>Trabajando ahora (${rows.length}):</b>\n${list}`;
}

async function handleHoursToday(emp) {
  const { rows } = await query(
    `SELECT clock_in, clock_out FROM work_records WHERE user_id=$1 AND date=$2`,
    [emp.id, today()]
  );
  if (!rows.length) return `📋 <b>${esc(emp.name)}</b> no tiene registros de hoy.`;
  let mins = 0;
  for (const r of rows) {
    const out = r.clock_out ? new Date(r.clock_out) : new Date();
    mins += Math.round((out - new Date(r.clock_in)) / 60000);
  }
  return `⏱ <b>${esc(emp.name)}</b> lleva <b>${fmtHours(mins)}</b> trabajados hoy.`;
}

async function handleHoursWeek(emp) {
  const { from, to } = weekRange();
  const { rows } = await query(
    `SELECT clock_in, clock_out FROM work_records WHERE user_id=$1 AND date BETWEEN $2 AND $3`,
    [emp.id, from, to]
  );
  if (!rows.length) return `📋 <b>${esc(emp.name)}</b> no tiene registros esta semana.`;
  let mins = 0;
  for (const r of rows) {
    if (!r.clock_out) continue;
    mins += Math.round((new Date(r.clock_out) - new Date(r.clock_in)) / 60000);
  }
  return `📊 <b>${esc(emp.name)}</b> trabajó <b>${fmtHours(mins)}</b> esta semana (lun–hoy).`;
}

async function handleRestDay(emp) {
  const { rows } = await query(
    `SELECT note FROM rest_days WHERE user_id=$1 AND date=$2`,
    [emp.id, today()]
  );
  if (!rows.length) return `📋 <b>${esc(emp.name)}</b> no tiene descanso hoy.`;
  const note = rows[0].note ? ` (${esc(rows[0].note)})` : '';
  return `🏖 <b>${esc(emp.name)}</b> tiene descanso hoy${note}.`;
}

async function handlePayroll(emp) {
  const year = new Date().getFullYear();
  const { rows } = await query(
    `SELECT COUNT(*)::int AS payments, COALESCE(SUM(amount),0) AS total
     FROM payroll WHERE user_id=$1 AND LEFT(payment_date,4)=$2`,
    [emp.id, String(year)]
  );
  const { payments, total } = rows[0];
  const fmt = Number(total).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return `💰 <b>${esc(emp.name)}</b> — pagos ${year}: <b>${esc(fmt)}</b> (${payments} pago${payments !== 1 ? 's' : ''}).`;
}

function helpMessage() {
  return `🤖 <b>ABC Midwest Bot</b> — ejemplos de preguntas:\n\n` +
    `• <i>¿Juan hizo la ponchada?</i>\n` +
    `• <i>¿Quién está trabajando ahora?</i>\n` +
    `• <i>¿Cuántas horas trabajó María esta semana?</i>\n` +
    `• <i>¿Cuántas horas lleva Luis hoy?</i>\n` +
    `• <i>¿Carlos tiene descanso hoy?</i>\n` +
    `• <i>¿Cuánto se le ha pagado a Ana este año?</i>`;
}

// ── Main message handler ──────────────────────────────────────────────────────

async function handleMessage(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Optional allowlist check
  const allowed = process.env.TELEGRAM_ALLOWED_IDS;
  if (allowed) {
    const ids = allowed.split(',').map(s => s.trim());
    if (!ids.includes(String(chatId))) return; // silently ignore
  }

  const intent = detectIntent(text);

  if (intent === 'help') {
    return bot.sendMessage(chatId, helpMessage(), { parse_mode: 'HTML' });
  }

  if (intent === 'who_working') {
    const reply = await handleWhoWorking();
    return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
  }

  // All other intents need an employee name
  const emp = await findEmployee(text);
  if (!emp) {
    return bot.sendMessage(chatId,
      '❓ No encontré ningún empleado en tu mensaje. Escribe el nombre completo o parte del nombre.'
    );
  }

  let reply;
  if (intent === 'clock_in')         reply = await handleClockIn(emp);
  else if (intent === 'hours_today') reply = await handleHoursToday(emp);
  else if (intent === 'hours_week')  reply = await handleHoursWeek(emp);
  else if (intent === 'rest_day')    reply = await handleRestDay(emp);
  else if (intent === 'payroll')     reply = await handlePayroll(emp);
  else                               reply = await handleClockIn(emp);

  return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return;
  }
  const bot = new TelegramBot(token, { polling: true });
  bot.on('message', msg => {
    handleMessage(bot, msg).catch(err => {
      console.error('Telegram handler error:', err);
      bot.sendMessage(msg.chat.id, '⚠️ Error interno. Intenta de nuevo.').catch(() => {});
    });
  });
  console.log('Telegram bot started (polling)');
}

module.exports = { initTelegramBot };
