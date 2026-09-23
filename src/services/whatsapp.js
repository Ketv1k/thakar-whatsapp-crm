// Thin wrapper around Meta's WhatsApp Cloud API.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
const crypto = require('crypto');
const axios = require('axios');

function apiVersion() {
  return process.env.WHATSAPP_API_VERSION || 'v20.0';
}

function client() {
  const version = apiVersion();
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
  // Unique per message: outgoing ids share a unique index with incoming ones.
  return { messages: [{ id: `wamid.TEST.${crypto.randomUUID()}` }] };
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

// Downloads a photo / voice note / file a customer sent. WhatsApp only gives a
// media id in the webhook; the id is swapped for a short-lived URL, which is
// then fetched with the same token. Returns { stream, mimeType, size }.
// Media stays downloadable for about 30 days after it was sent.
async function downloadMedia(mediaId, kind) {
  if (testMode()) return testMedia(kind);
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WHATSAPP_TOKEN not configured');
  const headers = { Authorization: `Bearer ${token}` };

  const { data: info } = await axios.get(
    `https://graph.facebook.com/${apiVersion()}/${encodeURIComponent(mediaId)}`,
    { headers, timeout: 10000 }
  );
  const file = await axios.get(info.url, { headers, responseType: 'stream', timeout: 30000 });
  return {
    stream: file.data,
    mimeType: info.mime_type || file.headers['content-type'] || 'application/octet-stream',
    size: Number(info.file_size || file.headers['content-length']) || null,
  };
}

// Stand-ins for simulated photos and voice notes in test mode, so the inbox can
// show and play them without WhatsApp: a labelled picture and a short tune.
function testMedia(kind) {
  const { Readable } = require('stream');
  if (kind === 'audio') {
    const buf = testTone();
    return { stream: Readable.from([buf]), mimeType: 'audio/wav', size: buf.length };
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<rect width="640" height="480" fill="#E7D2AE"/>
<rect x="200" y="150" width="240" height="150" rx="14" fill="none" stroke="#6B4E2A" stroke-width="10"/>
<circle cx="260" cy="200" r="18" fill="#6B4E2A"/><path d="M210 290l80-70 60 50 40-30 50 50" fill="none" stroke="#6B4E2A" stroke-width="10"/>
<text x="320" y="360" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#6B4E2A">Test photo</text>
<text x="320" y="400" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#6B4E2A">A real customer photo shows here</text></svg>`;
  const buf = Buffer.from(svg);
  return { stream: Readable.from([buf]), mimeType: 'image/svg+xml', size: buf.length };
}

// ~3 seconds of a soft three-note tune as an 8 kHz mono WAV.
function testTone() {
  const rate = 8000;
  const notes = [523.25, 659.25, 783.99];
  const samples = rate * 3;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const f = notes[Math.min(notes.length - 1, Math.floor(t))];
    const envelope = Math.min(1, (t % 1) * 20) * (1 - (t % 1));
    buf[44 + i] = Math.round(128 + 60 * envelope * Math.sin(2 * Math.PI * f * t));
  }
  return buf;
}

module.exports = { sendTextMessage, sendTemplateMessage, markMessageRead, downloadMedia };
