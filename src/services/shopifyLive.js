// The live link with Shopify, both ways:
//  - Instant updates: Shopify calls /shopify/webhooks the moment an order,
//    fulfillment, customer, checkout or stock level changes, so order
//    messages go out at once and profiles stay current. (The regular syncs
//    keep running as a safety net.)
//  - Changes made here go back: customer tags and notes (shopifyPush), and
//    who gets offers on WhatsApp (Shopify's WhatsApp marketing consent).
const crypto = require('crypto');
const Customer = require('../models/Customer');
const shopify = require('./shopify');
const settings = require('./settings');

const TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'CUSTOMERS_CREATE',
  'CUSTOMERS_UPDATE',
  'CHECKOUTS_CREATE',
  'CHECKOUTS_UPDATE',
  'INVENTORY_LEVELS_UPDATE',
  'PRODUCTS_UPDATE',
];

function publicUrl() {
  return String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
}

function callbackUrl() {
  const base = publicUrl();
  return base ? `${base}/shopify/webhooks` : null;
}

function webhookSecret() {
  return process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET || '';
}

// Shopify signs each call with the app's secret (base64 HMAC-SHA256).
function verifyHmac(rawBody, header, secret = webhookSecret()) {
  if (!secret || !header || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(String(header), 'base64');
  } catch (err) {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Asks Shopify to call us for every topic we use (only adds what's missing).
async function ensureWebhooks() {
  const uri = callbackUrl();
  if (!shopify.isConfigured() || !uri) return { skipped: uri ? 'Shopify not connected' : 'No public address (PUBLIC_URL) yet' };
  const data = await shopify.graphql(`{ webhookSubscriptions(first: 100) { edges { node { id topic uri } } } }`);
  const have = new Set(data.webhookSubscriptions.edges.filter((e) => e.node.uri === uri).map((e) => e.node.topic));
  const errors = [];
  let added = 0;
  for (const topic of TOPICS.filter((t) => !have.has(t))) {
    const res = await shopify.graphql(
      `mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { message } }
      }`,
      { topic, sub: { uri, format: 'JSON' } }
    );
    const err = res.webhookSubscriptionCreate.userErrors[0];
    if (err) errors.push(`${topic}: ${err.message}`);
    else added++;
  }
  const state = { uri, topics: TOPICS.length - errors.length, added, errors, checkedAt: new Date() };
  await settings.merge('shopify:webhooks', state);
  return state;
}

// ---------- Receiving ----------
const seen = new Map(); // webhook id -> time, so Shopify's retries run once
const timers = new Map();

// Runs a job at most once per `ms` however many events arrive (e.g. stock).
function soon(name, ms, fn) {
  if (timers.has(name)) return;
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      Promise.resolve(fn()).catch((err) => console.error(`[shopify-live] ${name} failed`, err.message));
    }, ms)
  );
}

// What each Shopify topic means for the app. Pure (returns the action).
function actionFor(topic, payload) {
  const t = String(topic || '').toLowerCase();
  if (t.startsWith('orders/')) return payload.admin_graphql_api_id ? { kind: 'order', id: payload.admin_graphql_api_id } : null;
  if (t.startsWith('fulfillments/')) return payload.order_id ? { kind: 'order', id: `gid://shopify/Order/${payload.order_id}` } : null;
  if (t.startsWith('customers/')) return payload.admin_graphql_api_id ? { kind: 'customer', id: payload.admin_graphql_api_id } : null;
  if (t.startsWith('checkouts/')) return { kind: 'carts' };
  if (t.startsWith('inventory_levels/') || t.startsWith('products/')) return { kind: 'stock' };
  return null;
}

async function handle(topic, payload) {
  const action = actionFor(topic, payload);
  if (!action) return null;
  const { runJob } = require('../jobs/scheduler');
  if (action.kind === 'order') return require('./orderSync').syncOne(action.id);
  if (action.kind === 'customer') return require('./customerSync').syncOne(action.id);
  if (action.kind === 'carts') return soon('carts', 60 * 1000, () => runJob('carts'));
  if (action.kind === 'stock') return soon('stock', 60 * 1000, () => runJob('stock'));
  return null;
}

// Express handler for POST /shopify/webhooks (raw body).
async function receive(req, res) {
  if (!verifyHmac(req.body, req.get('X-Shopify-Hmac-Sha256'))) return res.status(401).send('bad signature');
  const shop = req.get('X-Shopify-Shop-Domain');
  if (shop && process.env.SHOPIFY_STORE_DOMAIN && shop !== process.env.SHOPIFY_STORE_DOMAIN) return res.status(200).send('other shop');
  const id = req.get('X-Shopify-Webhook-Id') || req.get('X-Shopify-Event-Id');
  res.status(200).send('ok'); // answer fast; Shopify retries slow replies
  if (id) {
    if (seen.has(id)) return;
    seen.set(id, Date.now());
    if (seen.size > 2000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k);
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return;
  }
  const topic = req.get('X-Shopify-Topic');
  settings.merge('shopify:webhooks', { lastEventAt: new Date(), lastTopic: topic }).catch(() => {});
  handle(topic, payload).catch((err) => console.error('[shopify-live]', topic, err.message));
}

// ---------- Sending changes back ----------
async function mutate(query, variables, key) {
  const data = await shopify.graphql(query, variables);
  const err = (data[key].userErrors || [])[0];
  if (err) throw new Error(err.message);
  return data[key];
}

// Sends a customer's waiting tag/note changes. Returns 'saved' | 'failed' | 'none'.
async function pushCustomer(c) {
  const p = c.shopifyPush;
  if (!p || !c.shopifyCustomerId) return 'none';
  try {
    if (p.tagsAdd && p.tagsAdd.length) {
      await mutate(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: c.shopifyCustomerId, tags: p.tagsAdd }, 'tagsAdd');
    }
    if (p.tagsRemove && p.tagsRemove.length) {
      await mutate(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: c.shopifyCustomerId, tags: p.tagsRemove }, 'tagsRemove');
    }
    if (p.note != null) {
      await mutate(`mutation($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { message } } }`, { input: { id: c.shopifyCustomerId, note: p.note } }, 'customerUpdate');
    }
    // Only clear it if nothing new was queued meanwhile.
    await Customer.updateOne({ _id: c._id, 'shopifyPush.v': p.v }, { $unset: { shopifyPush: 1 } });
    return 'saved';
  } catch (err) {
    await Customer.updateOne({ _id: c._id }, { $set: { 'shopifyPush.failedAt': new Date(), 'shopifyPush.error': err.message.slice(0, 200) } });
    console.error('[shopify-live] customer push failed', err.message);
    return 'failed';
  }
}

// Pure: adds a tag/note change to what's waiting to go to Shopify.
function queueChange(pending, { added = [], removed = [], note } = {}) {
  const p = pending ? { tagsAdd: [...(pending.tagsAdd || [])], tagsRemove: [...(pending.tagsRemove || [])], note: pending.note ?? null, v: pending.v || 0 } : { tagsAdd: [], tagsRemove: [], note: null, v: 0 };
  const lower = (list) => list.map((t) => t.toLowerCase());
  for (const t of added) {
    p.tagsRemove = p.tagsRemove.filter((x) => x.toLowerCase() !== t.toLowerCase());
    if (!lower(p.tagsAdd).includes(t.toLowerCase())) p.tagsAdd.push(t);
  }
  for (const t of removed) {
    p.tagsAdd = p.tagsAdd.filter((x) => x.toLowerCase() !== t.toLowerCase());
    if (!lower(p.tagsRemove).includes(t.toLowerCase())) p.tagsRemove.push(t);
  }
  if (note !== undefined) p.note = note;
  p.v += 1;
  return p;
}

// WhatsApp marketing consent -> Shopify, for customers whose opt-in changed.
// (Not in test mode: test opt-ins aren't real.)
async function pushConsent(c) {
  const state = c.optedInMarketing ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
  try {
    await mutate(
      `mutation($input: CustomerWhatsAppMarketingConsentUpdateInput!) { customerWhatsAppMarketingConsentUpdate(input: $input) { userErrors { message } } }`,
      {
        input: {
          customerId: c.shopifyCustomerId,
          whatsAppMarketingConsent: { state, optInLevel: 'SINGLE_OPT_IN', updatedAt: new Date(c.optedInMarketing ? c.optedInAt || Date.now() : c.optedOutAt || Date.now()).toISOString() },
        },
      },
      'customerWhatsAppMarketingConsentUpdate'
    );
    await Customer.updateOne({ _id: c._id }, { $set: { shopifyWaConsent: state, shopifyWaConsentTriedAt: new Date() } });
    return true;
  } catch (err) {
    await Customer.updateOne({ _id: c._id }, { $set: { shopifyWaConsentTriedAt: new Date() } });
    console.error('[shopify-live] consent push failed', err.message);
    return false;
  }
}

function consentPending(now = new Date()) {
  return {
    $and: [
      { shopifyCustomerId: { $ne: null } },
      {
        $or: [
          { optedInMarketing: true, shopifyWaConsent: { $ne: 'SUBSCRIBED' } },
          { optedInMarketing: { $ne: true }, optedOutAt: { $ne: null }, shopifyWaConsent: { $ne: 'UNSUBSCRIBED' } },
        ],
      },
      { $or: [{ shopifyWaConsentTriedAt: null }, { shopifyWaConsentTriedAt: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }] },
    ],
  };
}

// Every few minutes: anything still waiting to go to Shopify.
async function pushPending() {
  if (!shopify.isConfigured()) return { skipped: 'Shopify not connected' };
  const retryAfter = new Date(Date.now() - 30 * 60 * 1000);
  const waiting = await Customer.find({
    shopifyCustomerId: { $ne: null },
    shopifyPush: { $exists: true },
    $or: [{ 'shopifyPush.failedAt': null }, { 'shopifyPush.failedAt': { $exists: false } }, { 'shopifyPush.failedAt': { $lt: retryAfter } }],
  })
    .limit(150)
    .lean();
  let saved = 0;
  for (const c of waiting) if ((await pushCustomer(c)) === 'saved') saved++;
  let consent = 0;
  if (process.env.TEST_MODE !== 'true') {
    const list = await Customer.find(consentPending()).limit(150).select('shopifyCustomerId optedInMarketing optedInAt optedOutAt').lean();
    for (const c of list) if (await pushConsent(c)) consent++;
  }
  return { customerChanges: saved, waiting: waiting.length, consent };
}

async function status() {
  const s = await settings.get('shopify:webhooks', {});
  const waiting = await Customer.countDocuments({ shopifyPush: { $exists: true } });
  return {
    instant: !!(s.uri && s.topics),
    uri: s.uri || null,
    topics: s.topics || 0,
    errors: s.errors || [],
    lastEventAt: s.lastEventAt || null,
    checkedAt: s.checkedAt || null,
    publicUrl: publicUrl() || null,
    waitingToSend: waiting,
    consentToShopify: process.env.TEST_MODE !== 'true',
  };
}

module.exports = {
  TOPICS,
  verifyHmac,
  ensureWebhooks,
  actionFor,
  handle,
  receive,
  pushCustomer,
  queueChange,
  pushConsent,
  consentPending,
  pushPending,
  status,
};
