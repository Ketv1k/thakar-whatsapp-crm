// Thin wrapper around Meta's WhatsApp Cloud API.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
const axios = require('axios');

function client() {
  const version = process.env.WHATSAPP_API_VERSION || 'v20.0';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN not configured');
  }

  return axios.create({
    baseURL: `https://graph.facebook.com/${version}/${phoneNumberId}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
}

// TEST_MODE=true lets the whole app be tried out before WhatsApp is connected:
// every outgoing message is logged instead of sent, and a fake id returned.
function testMode() {
  return process.env.TEST_MODE === 'true';
}

function notSent(toPhone, what) {
  console.log(`[test mode] not sent to …${String(toPhone).slice(-4)}: ${what}`);
  return { messages: [{ id: `wamid.TEST.${Date.now()}` }] };
}

// Free-form text reply. Only works inside the 24-hour customer service window,
// i.e. after the customer has messaged you (which is true for everything in
// this triage flow - replies, acknowledgments, SLA context).
async function sendTextMessage(toPhone, body) {
  if (testMode()) return notSent(toPhone, body);
  const api = client();
  const { data } = await api.post('/messages', {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'text',
    text: { body, preview_url: false },
  });
  return data;
}

// Business-initiated message using a pre-approved template. Needed for anything
// outside the 24h window - order/shipping updates, broadcasts, cart recovery.
// `components` follows Meta's template component format (for {{1}} style variables).
async function sendTemplateMessage(toPhone, templateName, languageCode = 'en', components = []) {
  if (testMode()) return notSent(toPhone, `[template ${templateName}]`);
  const api = client();
  const { data } = await api.post('/messages', {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  });
  return data;
}

async function markMessageRead(waMessageId) {
  if (testMode()) return;
  const api = client();
  await api.post('/messages', {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: waMessageId,
  });
}

module.exports = { sendTextMessage, sendTemplateMessage, markMessageRead };
