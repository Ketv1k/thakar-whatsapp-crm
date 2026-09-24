// Marketing opt-in and opt-out on WhatsApp. Customers reply STOP (or tap
// "Stop promotions" on an offer) to stop offers and START to get them again.
// STOP keeps order updates; STOP ALL stops every WhatsApp message.
const Customer = require('../models/Customer');
const StockAlert = require('../models/StockAlert');
const outbound = require('./outbound');
const consent = require('./consent');

const STOP_WORDS = new Set([
  'stop', 'unsubscribe', 'stop promotions', 'stop promotion', 'stop all', 'opt out', 'optout',
  'stop offers', 'stop messages', 'no more messages', 'unsub',
]);
const ALL_WORDS = new Set(['stop all', 'stop everything', 'stop all messages', 'unsubscribe all', 'block', 'dont message me', 'do not message me']);
const START_WORDS = new Set([
  'start', 'subscribe', 'unstop', 'opt in', 'optin', 'start offers', 'start promotions',
  // The message the "get offers on WhatsApp" link fills in (routes/customers.js).
  'yes send me offers',
]);

// 'stop' | 'start' | null for a whole message (not a word inside a sentence).
function detectKeyword(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ALL_WORDS.has(t)) return 'stop_all';
  if (STOP_WORDS.has(t)) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  return null;
}

const REPLIES = {
  stop: "You won't get offers from Thakar Kitchen on WhatsApp any more. You'll still get updates about your orders (reply STOP ALL to stop those too). Reply START anytime to get offers again.",
  stop_all: "You won't get any more WhatsApp messages from Thakar Kitchen, including order updates. You can still message us here anytime. Reply START to get messages again.",
  start: "Thank you! You'll now get offers and new launches from Thakar Kitchen here. Reply STOP anytime to stop.",
};

async function setOptIn(phone, optedIn, source, { evidence = '', all = false } = {}) {
  const now = new Date();
  const update = optedIn
    ? { $set: consent.optInFields({ source, evidence, at: now }) }
    : { $set: { optedInMarketing: false, optedOutAt: now, optInSource: null, ...(all ? { noWhatsApp: true, noWhatsAppAt: now } : {}) } };
  await Customer.updateOne({ phone }, { ...update, $setOnInsert: { phone } }, { upsert: true });
  if (!optedIn) {
    // Someone who says stop shouldn't get a restock "offer" either.
    await StockAlert.updateMany({ phone, status: 'waiting' }, { $set: { status: 'cancelled', note: 'Customer replied STOP' } });
  }
}

// Applies a STOP/START from the customer and confirms it to them.
async function applyKeyword(keyword, { fromPhone, conversation, text = '' }) {
  const said = String(text || keyword).trim().slice(0, 60);
  await setOptIn(fromPhone, keyword === 'start', 'keyword', {
    evidence: `Sent "${said}" on WhatsApp on ${consent.stamp()}`,
    all: keyword === 'stop_all',
  });
  await outbound.sendText({
    conversationId: conversation._id,
    to: fromPhone,
    body: REPLIES[keyword],
    autoAck: keyword === 'start' ? 'opt_in' : 'opt_out',
  });
}

module.exports = { detectKeyword, applyKeyword, setOptIn, REPLIES };
