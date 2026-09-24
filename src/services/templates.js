// WhatsApp message templates. A business can only message a customer first
// (order updates, reminders, campaigns) with a template Meta has approved.
//
// - CATALOG: the templates the built-in automations use. They're added to the
//   database on startup and can be submitted to Meta from the Automations page.
// - Custom marketing templates are made on the Campaigns page.
// - Templates made directly in WhatsApp Manager are imported by "Refresh".
//
// Templates are stored in Meta's own component format, so the same data is
// used to submit, preview (render) and send them.
const axios = require('axios');
const Template = require('../models/Template');

const STOP_BUTTON = 'Stop promotions';

const CATALOG = [
  {
    name: 'order_confirmed',
    label: 'Order confirmed',
    category: 'UTILITY',
    body:
      "Hi {{1}}, thank you for your order {{2}} from Thakar Kitchen! We've received it and will pack it fresh. Order total: {{3}}.\n\nWe'll send you the tracking link here as soon as it ships.",
    examples: ['Priya', '#3451', '₹640'],
  },
  {
    name: 'cod_confirmation',
    label: 'COD confirmation',
    category: 'UTILITY',
    body:
      'Hi {{1}}, thank you for your order {{2}} from Thakar Kitchen. Amount to pay on delivery: {{3}}.\n\nPlease confirm your order so we can pack and ship it.',
    examples: ['Priya', '#3451', '₹1,151'],
    quickReplies: ['Confirm order', 'Cancel order'],
  },
  {
    name: 'order_shipped',
    label: 'Order shipped',
    category: 'UTILITY',
    body:
      'Hi {{1}}, good news! Your Thakar Kitchen order {{2}} has been shipped.\n\nTrack it here: {{3}}\n\nThank you for ordering with us!',
    examples: ['Priya', '#3451', 'https://thakarkitchen.com'],
  },
  {
    name: 'order_out_for_delivery',
    label: 'Out for delivery',
    category: 'UTILITY',
    body:
      'Hi {{1}}, your Thakar Kitchen order {{2}} is out for delivery today. Please keep your phone handy for the delivery partner.\n\nThank you for ordering with us!',
    examples: ['Priya', '#3451'],
  },
  {
    name: 'order_delivered',
    label: 'Order delivered',
    category: 'UTILITY',
    body:
      "Hi {{1}}, your Thakar Kitchen order {{2}} has been delivered. We hope you enjoy every bite!\n\nIf anything isn't right, just reply to this message and we'll help.",
    examples: ['Priya', '#3451'],
  },
  {
    name: 'cart_reminder',
    label: 'Cart reminder',
    category: 'MARKETING',
    body:
      'Hi {{1}}, you left {{2}} in your cart at Thakar Kitchen. Your order is just a tap away:\n\n{{3}}\n\nNeed help choosing? Just reply here.',
    examples: ['Priya', 'Kaju Curry and 2 more', 'https://thakarkitchen.com'],
    quickReplies: [STOP_BUTTON],
  },
  {
    name: 'reorder_reminder',
    label: 'Reorder reminder',
    category: 'MARKETING',
    body:
      "Hi {{1}}, hope you enjoyed your {{2}}! Running low? You can reorder your favourites here:\n\n{{3}}\n\nReply here if you'd like help with your order.",
    examples: ['Priya', 'Kaju Curry', 'https://thakarkitchen.com'],
    quickReplies: [STOP_BUTTON],
  },
  {
    name: 'back_in_stock',
    label: 'Back in stock',
    category: 'MARKETING',
    body:
      'Good news, {{1}}! {{2}} is back in stock at Thakar Kitchen. Order it here before it sells out again:\n\n{{3}}\n\nThank you for waiting for us!',
    examples: ['Priya', 'Methi Papad', 'https://thakarkitchen.com'],
    quickReplies: [STOP_BUTTON],
  },
  {
    // To your own number (FOUNDER_PHONE), when a ticket waits too long and
    // you haven't messaged the business number in the last 24 hours.
    name: 'team_ticket_alert',
    label: 'Ticket waiting (alert to you)',
    category: 'UTILITY',
    body: 'Thakar Kitchen inbox: ticket #{{1}} ({{2}}) has been waiting for a reply for {{3}} hours. Open the inbox to answer it.',
    examples: ['1042', 'Late delivery', '6'],
  },
];

// Meta's component list for a simple template: body (+ example values) and
// optional buttons.
function buildComponents({ body, examples = [], quickReplies = [], urlButton = null }) {
  const bodyComponent = { type: 'BODY', text: body };
  if (examples.length) bodyComponent.example = { body_text: [examples] };
  const components = [bodyComponent];
  const buttons = [];
  if (urlButton) buttons.push({ type: 'URL', text: urlButton.text, url: urlButton.url });
  for (const text of quickReplies) buttons.push({ type: 'QUICK_REPLY', text });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  return components;
}

// ---- Reading a template ----
function component(t, type) {
  return (t.components || []).find((c) => String(c.type).toUpperCase() === type) || null;
}

function bodyText(t) {
  const body = component(t, 'BODY');
  return body ? body.text || '' : '';
}

function paramCount(t) {
  const nums = [...bodyText(t).matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

function headerFormat(t) {
  const header = component(t, 'HEADER');
  return header ? String(header.format || 'TEXT').toUpperCase() : null;
}

function buttons(t) {
  const b = component(t, 'BUTTONS');
  return b ? b.buttons || [] : [];
}

function quickReplies(t) {
  return buttons(t).filter((b) => String(b.type).toUpperCase() === 'QUICK_REPLY').map((b) => b.text);
}

// Why a template can't be sent by this app, or null. (Header text or URL
// buttons with their own variables aren't supported - rare in practice.)
function unsupportedReason(t) {
  const header = component(t, 'HEADER');
  if (header && headerFormat(t) === 'TEXT' && /\{\{\d+\}\}/.test(header.text || '')) return 'Its heading has a variable';
  if (header && ['VIDEO', 'DOCUMENT', 'LOCATION'].includes(headerFormat(t))) return `It has a ${headerFormat(t).toLowerCase()} heading`;
  if (buttons(t).some((b) => String(b.type).toUpperCase() === 'URL' && /\{\{\d+\}\}/.test(b.url || ''))) return 'Its link button has a variable';
  return null;
}

// WhatsApp rejects variables that are empty or contain line breaks, tabs or
// long runs of spaces.
function cleanParam(value) {
  const s = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 500);
  return s || '-';
}

// The message text as the customer will see it.
function render(t, params = []) {
  return bodyText(t).replace(/\{\{(\d+)\}\}/g, (m, n) => (params[Number(n) - 1] != null ? cleanParam(params[Number(n) - 1]) : m));
}

// The `components` part of Meta's send-message call.
function sendComponents(t, { bodyParams = [], headerImageUrl = '', quickReplyPayloads = {} } = {}) {
  const out = [];
  if (headerFormat(t) === 'IMAGE') {
    out.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  }
  const count = paramCount(t);
  if (count > 0) {
    const parameters = [];
    for (let i = 0; i < count; i++) parameters.push({ type: 'text', text: cleanParam(bodyParams[i]) });
    out.push({ type: 'body', parameters });
  }
  buttons(t).forEach((b, index) => {
    if (String(b.type).toUpperCase() !== 'QUICK_REPLY') return;
    const payload = quickReplyPayloads[b.text];
    if (payload) {
      out.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] });
    }
  });
  return out;
}

// ---- Rules for templates made in the app ----
function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// Meta's main rules, checked up front so the founder gets a clear message
// instead of a rejection a day later. Returns an error string or null.
function validateBody(body) {
  const text = String(body || '').trim();
  if (!text) return 'Write the message first.';
  if (text.length > 1024) return 'Keep the message under 1,024 characters.';
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  if (unique.some((n, i) => n !== i + 1)) return 'Number the blanks in order: {{1}}, {{2}}, {{3}}…';
  if (/^\{\{\d+\}\}/.test(text) || /\{\{\d+\}\}$/.test(text)) {
    return "WhatsApp doesn't allow a message to start or end with a blank. Add a few words before or after it.";
  }
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) return 'Put some words between two blanks.';
  const words = text.replace(/\{\{\d+\}\}/g, ' ').split(/\s+/).filter(Boolean).length;
  if (unique.length && words < unique.length * 3) return 'Add more words around the blanks; WhatsApp rejects messages that are mostly blanks.';
  return null;
}

// ---- Meta (WhatsApp Business Management API) ----
function testMode() {
  return process.env.TEST_MODE === 'true';
}

// Templates can be submitted and checked only with the WhatsApp Business
// Account id, and never in test mode.
function metaReady() {
  return !testMode() && !!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID && !!process.env.WHATSAPP_TOKEN;
}

function metaApi() {
  const version = process.env.WHATSAPP_API_VERSION || 'v25.0';
  return axios.create({
    baseURL: `https://graph.facebook.com/${version}/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}`,
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    timeout: 15000,
  });
}

function metaError(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  if (!e) return err.message || 'Request failed';
  return e.error_user_msg || e.error_user_title || e.message || 'Request failed';
}

async function listMetaTemplates() {
  const api = metaApi();
  const all = [];
  let url = '/message_templates?fields=id,name,status,category,language,components,rejected_reason&limit=100';
  for (let page = 0; url && page < 20; page++) {
    const { data } = await api.get(url);
    all.push(...(data.data || []));
    url = data.paging && data.paging.next ? data.paging.next : null;
  }
  return all;
}

// Pulls every template's status from Meta and imports ones made in WhatsApp
// Manager. Returns how many were updated.
async function refreshFromMeta() {
  if (!metaReady()) return { updated: 0, skipped: true };
  const remote = await listMetaTemplates();
  let updated = 0;
  for (const r of remote) {
    const res = await Template.updateOne(
      { name: r.name, language: r.language },
      {
        $set: {
          status: r.status,
          category: r.category,
          components: r.components || [],
          metaId: r.id,
          rejectedReason: r.rejected_reason && r.rejected_reason !== 'NONE' ? r.rejected_reason : null,
          checkedAt: new Date(),
        },
        $setOnInsert: { source: 'meta', label: r.name.replace(/_/g, ' ') },
      },
      { upsert: true }
    );
    if (res.modifiedCount || res.upsertedCount) updated++;
  }
  return { updated, skipped: false };
}

async function submitToMeta(template) {
  if (!metaReady()) {
    throw Object.assign(new Error('Connect WhatsApp first (and turn off test mode) to submit templates to Meta.'), {
      status: 409,
      expose: true,
    });
  }
  try {
    const { data } = await metaApi().post('/message_templates', {
      name: template.name,
      language: template.language,
      category: template.category,
      components: template.components,
    });
    template.metaId = data.id;
    template.status = data.status || 'PENDING';
    template.submittedAt = new Date();
    template.rejectedReason = null;
    await template.save();
    return template;
  } catch (err) {
    throw Object.assign(new Error(`Meta said: ${metaError(err)}`), { status: 400, expose: true });
  }
}

// Adds the built-in templates to the database. Wording changes in CATALOG
// reach templates not yet sent to Meta; once submitted, Meta's copy is kept.
async function ensureCatalog() {
  for (const c of CATALOG) {
    const fields = {
      category: c.category,
      label: c.label,
      examples: c.examples,
      components: buildComponents({ body: c.body, examples: c.examples, quickReplies: c.quickReplies || [] }),
    };
    const updated = await Template.updateOne({ name: c.name, language: 'en', status: 'not_submitted' }, { $set: fields });
    if (updated.matchedCount) continue;
    await Template.updateOne(
      { name: c.name, language: 'en' },
      { $setOnInsert: { name: c.name, language: 'en', source: 'catalog', status: 'not_submitted', ...fields } },
      { upsert: true }
    );
  }
}

async function findByName(name, language = 'en') {
  return Template.findOne({ name, language });
}

// In test mode anything can be "sent" (it's only logged). Live, WhatsApp only
// accepts approved templates - but without the business account id the app
// can't check, so it tries and shows WhatsApp's answer on the message.
function canSend(t) {
  if (!t) return false;
  if (testMode()) return true;
  if (!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) return true;
  return t.status === 'APPROVED';
}

function statusLabel(t) {
  if (!t) return 'Missing';
  if (testMode()) return 'Test mode';
  const map = {
    not_submitted: 'Not submitted',
    PENDING: 'Waiting for Meta',
    APPROVED: 'Approved by Meta',
    REJECTED: 'Rejected by Meta',
    PAUSED: 'Paused by Meta',
    DISABLED: 'Disabled by Meta',
    IN_APPEAL: 'In appeal',
  };
  return map[t.status] || t.status;
}

// What the app shows for a template.
function summary(t) {
  return {
    _id: t._id,
    name: t.name,
    label: t.label || t.name,
    language: t.language,
    category: t.category,
    source: t.source,
    status: t.status,
    statusLabel: statusLabel(t),
    rejectedReason: t.rejectedReason,
    body: bodyText(t),
    paramCount: paramCount(t),
    headerFormat: headerFormat(t),
    quickReplies: quickReplies(t),
    urlButtons: buttons(t).filter((b) => String(b.type).toUpperCase() === 'URL').map((b) => ({ text: b.text, url: b.url })),
    examples: t.examples || [],
    preview: render(t, t.examples && t.examples.length ? t.examples : []),
    canSend: canSend(t) && !unsupportedReason(t),
    unsupported: unsupportedReason(t),
  };
}

module.exports = {
  CATALOG,
  STOP_BUTTON,
  buildComponents,
  bodyText,
  paramCount,
  headerFormat,
  buttons,
  quickReplies,
  render,
  sendComponents,
  cleanParam,
  slugify,
  validateBody,
  unsupportedReason,
  metaReady,
  refreshFromMeta,
  submitToMeta,
  ensureCatalog,
  findByName,
  canSend,
  statusLabel,
  summary,
};
