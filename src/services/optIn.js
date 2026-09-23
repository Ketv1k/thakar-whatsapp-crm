// Marketing opt-in and opt-out on WhatsApp. Customers reply STOP (or tap
// "Stop promotions" on an offer) to stop offers and START to get them again.
// Order updates are not affected - they're about orders the customer placed.
const Customer = require('../models/Customer');
const StockAlert = require('../models/StockAlert');
const outbound = require('./outbound');

const STOP_WORDS = new Set([
  'stop', 'unsubscribe', 'stop promotions', 'stop promotion', 'stop all', 'opt out', 'optout',
  'stop offers', 'stop messages', 'no more messages', 'unsub',
]);
const START_WORDS = new Set(['start', 'subscribe', 'unstop', 'opt in', 'optin', 'start offers', 'start promotions']);

// 'stop' | 'start' | null for a whole message (not a word inside a sentence).
function detectKeyword(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (STOP_WORDS.has(t)) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  return null;
}

const REPLIES = {
  stop: "You won't get offers from Thakar Kitchen on WhatsApp any more. You'll still get updates about your orders. Reply START anytime to get offers again.",
  start: "Thank you! You'll now get offers and new launches from Thakar Kitchen here. Reply STOP anytime to stop.",
};

async function setOptIn(phone, optedIn, source) {
  const now = new Date();
  const update = optedIn
    ? { $set: { optedInMarketing: true, optInSource: source, optedInAt: now, optedOutAt: null } }
    : { $set: { optedInMarketing: false, optedOutAt: now, optInSource: null } };
  await Customer.updateOne({ phone }, { ...update, $setOnInsert: { phone } }, { upsert: true });
  if (!optedIn) {
    // Someone who says stop shouldn't get a restock "offer" either.
    await StockAlert.updateMany({ phone, status: 'waiting' }, { $set: { status: 'cancelled', note: 'Customer replied STOP' } });
  }
}

// Applies a STOP/START from the customer and confirms it to them.
async function applyKeyword(keyword, { fromPhone, conversation }) {
  await setOptIn(fromPhone, keyword === 'start', 'keyword');
  await outbound.sendText({
    conversationId: conversation._id,
    to: fromPhone,
    body: REPLIES[keyword],
    autoAck: keyword === 'stop' ? 'opt_out' : 'opt_in',
  });
}

module.exports = { detectKeyword, applyKeyword, setOptIn, REPLIES };
