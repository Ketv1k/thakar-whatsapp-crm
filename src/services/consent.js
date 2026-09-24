// WhatsApp permission, and how each person agreed.
//
//  - Order updates (confirmed, COD, shipped, delivered): every customer who
//    orders - they give their number at checkout for exactly this. Only a
//    STOP ALL reply stops them.
//  - Offers (campaigns, cart/reorder/back-in-stock reminders): only customers
//    who opted in to offers (optedInMarketing), with proof in optInEvidence.
const Customer = require('../models/Customer');

const ORDER_BASIS = 'gave their number when ordering';

// Pure: may this customer get order updates on WhatsApp?
function orderUpdatesAllowed(customer) {
  if (customer && customer.noWhatsApp) return { allowed: false, reason: 'They asked for no WhatsApp messages (STOP ALL)' };
  return { allowed: true, basis: ORDER_BASIS };
}

async function canSendOrderUpdates(phone) {
  return orderUpdatesAllowed(await Customer.findOne({ phone }).select('noWhatsApp').lean());
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

module.exports = { orderUpdatesAllowed, canSendOrderUpdates, optInFields, bulkEvidence, stamp };
