// WhatsApp permission. Meta only allows a business to message people first
// (order updates, reminders, offers) when they agreed to get WhatsApp
// messages from it - and asks businesses to honour opt-outs. This is where
// the app decides, and records how each person agreed.
//
//  - Offers (campaigns, cart/reorder/back-in-stock reminders): the customer
//    opted in to offers (optedInMarketing), with proof in optInEvidence.
//  - Order updates (confirmed, COD, shipped, delivered): either the owner has
//    confirmed that the checkout tells every customer they'll get order
//    updates on WhatsApp (the wording is stored), or this customer agreed
//    (opted in to offers, ticked WhatsApp at checkout, replied START...).
//  - Nobody who replied STOP ALL gets anything.
const Customer = require('../models/Customer');
const settings = require('./settings');

const ORDER_KEY = 'consent:orders';

async function orderBasis() {
  const s = await settings.get(ORDER_KEY, {});
  return s.mode === 'checkout' && s.wording
    ? { mode: 'checkout', wording: s.wording, confirmedAt: s.confirmedAt || null, confirmedBy: s.confirmedBy || '' }
    : { mode: 'individual' };
}

// The owner confirms (or withdraws) that the checkout asks for WhatsApp
// order updates. The wording and who confirmed it are kept as proof.
async function setOrderBasis({ mode, wording, by }) {
  if (mode === 'checkout') {
    const text = String(wording || '').trim().slice(0, 500);
    if (text.length < 15 || !/whats\s?app/i.test(text)) {
      throw Object.assign(new Error('Paste the exact words your checkout shows. They need to mention WhatsApp.'), { status: 400, expose: true });
    }
    await settings.set(ORDER_KEY, { mode: 'checkout', wording: text, confirmedAt: new Date(), confirmedBy: by || '' });
  } else {
    await settings.set(ORDER_KEY, { mode: 'individual', changedAt: new Date(), changedBy: by || '' });
  }
  return orderBasis();
}

// Pure: may this customer get order updates on WhatsApp?
function orderUpdatesAllowed(customer, basis) {
  if (customer && customer.noWhatsApp) return { allowed: false, reason: 'They asked for no WhatsApp messages (STOP ALL)' };
  if (basis && basis.mode === 'checkout') return { allowed: true, basis: 'checkout' };
  if (customer && customer.optedInMarketing) return { allowed: true, basis: 'opted in to offers' };
  if (customer && customer.orderUpdatesOptIn) return { allowed: true, basis: 'agreed to order updates' };
  return { allowed: false, reason: 'No WhatsApp permission for order updates' };
}

async function canSendOrderUpdates(phone) {
  const [customer, basis] = await Promise.all([
    Customer.findOne({ phone }).select('optedInMarketing orderUpdatesOptIn noWhatsApp').lean(),
    orderBasis(),
  ]);
  return orderUpdatesAllowed(customer, basis);
}

function stamp(date = new Date()) {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// The fields that opt someone in to offers, with proof of how.
function optInFields({ source, evidence, by = '', at = new Date() }) {
  return {
    optedInMarketing: true,
    optInSource: source,
    optedInAt: at,
    optedOutAt: null,
    noWhatsApp: false,
    optInEvidence: String(evidence || '').slice(0, 300),
    optInBy: String(by || '').slice(0, 60),
  };
}

// Proof text for a bulk action, e.g. "Agreed in Zoko — group opt-in by Ketvik on 24 Sept 2026".
function bulkEvidence(reason, what, by) {
  const why = String(reason || '').trim();
  if (why.length < 3) {
    throw Object.assign(new Error('Say where these customers agreed to get offers on WhatsApp'), { status: 400, expose: true });
  }
  return `${why.slice(0, 200)} — ${what}${by ? ` by ${by}` : ''} on ${stamp()}`;
}

module.exports = { orderBasis, setOrderBasis, orderUpdatesAllowed, canSendOrderUpdates, optInFields, bulkEvidence, stamp };
