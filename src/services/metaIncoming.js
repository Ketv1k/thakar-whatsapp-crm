// Whether customers' WhatsApp messages reach this app. Meta sends a WhatsApp
// Business Account's incoming messages to every app subscribed to it (so Zoko
// and this app can both receive them). The app's webhook address and verify
// token are set in the Meta app itself; this subscribes the account to it.
const axios = require('axios');

let cached = { at: 0, value: null };

function ready() {
  return !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
}

function graph() {
  return axios.create({
    baseURL: `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v25.0'}`,
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    timeout: 10000,
  });
}

function reason(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  return (e && (e.error_user_msg || e.message)) || err.message || 'Request failed';
}

// Pure: is our app among the account's subscribed apps?
function summarize(app, subscribed) {
  const names = (subscribed || []).map((s) => (s.whatsapp_business_api_data || s).name || (s.whatsapp_business_api_data || s).id);
  const connected = (subscribed || []).some((s) => String((s.whatsapp_business_api_data || s).id) === String(app.id));
  return { connected, appName: app.name || '', others: names.filter((n) => n && n !== app.name) };
}

async function status({ fresh = false } = {}) {
  if (!ready()) return null;
  if (!fresh && cached.value && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
  try {
    const api = graph();
    const [{ data: app }, { data: subs }] = await Promise.all([
      api.get('/app', { params: { fields: 'id,name' } }),
      api.get(`/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`),
    ]);
    cached = { at: Date.now(), value: summarize(app, subs.data) };
  } catch (err) {
    cached = { at: Date.now(), value: { connected: false, error: reason(err) } };
  }
  return cached.value;
}

async function connect() {
  if (!ready()) {
    throw Object.assign(new Error('Add WHATSAPP_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID in Render first.'), { status: 409, expose: true });
  }
  try {
    await graph().post(`/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`);
  } catch (err) {
    throw Object.assign(new Error(`Meta said: ${reason(err)}`), { status: 502, expose: true });
  }
  return status({ fresh: true });
}

module.exports = { status, connect, summarize };
