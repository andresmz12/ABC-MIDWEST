const twilio = require('twilio');

let _client = null;

function getClient() {
  if (_client) return _client;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  _client = twilio(sid, token);
  return _client;
}

async function sendSms(to, body) {
  const client = getClient();
  if (!client) {
    console.warn(`[SMS] Twilio not configured — skipping message to ${to}`);
    return;
  }
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) {
    console.warn('[SMS] TWILIO_PHONE_NUMBER not set');
    return;
  }
  try {
    await client.messages.create({ from, to, body });
    console.log(`[SMS] Sent to ${to}`);
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err.message);
  }
}

module.exports = { sendSms };
