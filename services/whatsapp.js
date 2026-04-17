const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let client = null;
let ready = false;

function getRecipients() {
  return (process.env.WHATSAPP_RECIPIENTS || '').split(',').map(n => n.trim()).filter(Boolean);
}

function initWhatsApp() {
  if (getRecipients().length === 0) {
    console.warn('WARNING: WHATSAPP_RECIPIENTS not set — WhatsApp reminders disabled.');
    return;
  }

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  client.on('qr', qr => {
    console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===');
    qrcode.generate(qr, { small: true });
    console.log('=========================================\n');
  });

  client.on('ready', () => {
    ready = true;
    console.log('WhatsApp client ready.');
  });

  client.on('auth_failure', msg => {
    console.error('WhatsApp auth failure:', msg);
    ready = false;
  });

  client.on('disconnected', reason => {
    console.warn('WhatsApp disconnected:', reason);
    ready = false;
  });

  client.initialize().catch(err => {
    console.error('WhatsApp init error:', err.message);
  });
}

async function sendWhatsAppMessage(phone, text) {
  if (!ready || !client) return;
  try {
    const chatId = phone.replace(/\D/g, '') + '@c.us';
    await client.sendMessage(chatId, text);
  } catch (err) {
    console.error(`WhatsApp send error (${phone}):`, err.message);
  }
}

async function broadcastWhatsAppMessage(text) {
  for (const phone of getRecipients()) {
    await sendWhatsAppMessage(phone, text);
  }
}

module.exports = { initWhatsApp, broadcastWhatsAppMessage, isReady: () => ready };
