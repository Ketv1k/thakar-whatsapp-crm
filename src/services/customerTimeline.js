// One customer's history in date order, for their profile: orders, chats,
// campaigns and reminders they got, carts they left, problems they reported,
// restock requests and offers opt-in/out.
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Order = require('../models/Order');
const Campaign = require('../models/Campaign');
const AbandonedCheckout = require('../models/AbandonedCheckout');
const Ticket = require('../models/Ticket');
const StockAlert = require('../models/StockAlert');
const { formatMoney } = require('../utils/money');

const ISSUES = {
  delay: 'Late delivery',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  missing: 'Missing item',
  refund_request: 'Refund request',
  quality: 'Quality complaint',
  payment: 'Payment issue',
  other: 'Other issue',
};

const REMINDERS = {
  cart_reminder: 'Got a cart reminder',
  reorder_reminder: 'Got a reorder reminder',
  back_in_stock: 'Got a back-in-stock message',
};

const OPT_IN_SOURCES = {
  manual: 'turned on by you',
  keyword: 'they replied START',
  bulk: 'group opt-in',
  shopify: 'agreed at checkout',
  import: 'imported list',
  checkout: 'ticked WhatsApp at checkout',
};

// Pure: groups a chat's messages into one line per day.
function chatDays(messages) {
  const days = new Map();
  for (const m of messages) {
    const d = new Date(m.createdAt);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const day = days.get(key) || { at: d, fromThem: 0, fromYou: 0, first: '' };
    if (m.direction === 'inbound') {
      day.fromThem++;
      if (!day.first) day.first = String(m.body || '').slice(0, 80);
    } else {
      day.fromYou++;
    }
    if (d > day.at) day.at = d;
    days.set(key, day);
  }
  return [...days.values()].map((d) => {
    const parts = [];
    if (d.fromThem) parts.push(`${d.fromThem} from them`);
    if (d.fromYou) parts.push(`${d.fromYou} from you`);
    return { at: d.at, kind: 'chat', text: `WhatsApp chat · ${parts.join(', ')}`, detail: d.first ? `“${d.first}”` : '' };
  });
}

async function timeline(phone, limit = 40) {
  const customer = await Customer.findOne({ phone }).lean();
  const conv = await Conversation.findOne({ customerPhone: phone }).select('_id').lean();
  const orderFilter = customer && customer.shopifyCustomerId ? { $or: [{ phone }, { shopifyCustomerId: customer.shopifyCustomerId }] } : { phone };
  const [orders, messages, carts, tickets, alerts] = await Promise.all([
    Order.find(orderFilter).sort({ placedAt: -1 }).limit(100).select('name placedAt cancelledAt total currency items isCod simulated').lean(),
    conv
      ? Message.find({ conversationId: conv._id }).sort({ createdAt: -1 }).limit(1000).select('direction body createdAt autoAck sentByFounder campaignId cart').lean()
      : [],
    AbandonedCheckout.find({ phone }).sort({ checkoutCreatedAt: -1 }).limit(20).select('checkoutCreatedAt total currency items recoveredAt recoveredOrderName').lean(),
    Ticket.find({ customerPhone: phone }).sort({ createdAt: -1 }).limit(30).select('ticketNumber issueType createdAt resolvedAt').lean(),
    StockAlert.find({ phone }).sort({ createdAt: -1 }).limit(20).select('productTitle variantTitle createdAt sentAt status').lean(),
  ]);

  const events = [];
  for (const o of orders) {
    const items = (o.items || []).map((i) => `${i.title}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ');
    if (o.placedAt) {
      events.push({
        at: o.placedAt,
        kind: 'order',
        text: `Ordered ${o.name} · ${formatMoney(o.total, o.currency)}${o.isCod ? ' · COD' : ''}${o.simulated ? ' · test' : ''}`,
        detail: items,
      });
    }
    if (o.cancelledAt) events.push({ at: o.cancelledAt, kind: 'cancel', text: `Order ${o.name} cancelled`, detail: '' });
  }

  const campaignIds = [...new Set(messages.filter((m) => m.campaignId).map((m) => String(m.campaignId)))];
  const campaigns = new Map(
    (await Campaign.find({ _id: { $in: campaignIds } }).select('name').lean()).map((c) => [String(c._id), c.name])
  );
  const chat = [];
  for (const m of messages) {
    if (m.campaignId) {
      events.push({ at: m.createdAt, kind: 'campaign', text: `Got campaign: ${campaigns.get(String(m.campaignId)) || 'a campaign'}`, detail: '' });
    } else if (m.cart) {
      events.push({ at: m.createdAt, kind: 'cart_link', text: `You sent a cart link · ${formatMoney(m.cart.total)}`, detail: (m.cart.items || []).map((i) => `${i.title} ×${i.quantity}`).join(', ') });
    } else if (REMINDERS[m.autoAck]) {
      events.push({ at: m.createdAt, kind: 'reminder', text: REMINDERS[m.autoAck], detail: '' });
    } else if (m.direction === 'inbound' || m.sentByFounder) {
      chat.push(m);
    }
  }
  events.push(...chatDays(chat));

  for (const c of carts) {
    events.push({
      at: c.checkoutCreatedAt,
      kind: 'cart',
      text: `Left a cart · ${formatMoney(c.total, c.currency)}${c.recoveredAt ? ` · came back and ordered ${c.recoveredOrderName || ''}`.trimEnd() : ''}`,
      detail: (c.items || []).join(', '),
    });
  }
  for (const t of tickets) {
    events.push({ at: t.createdAt, kind: 'ticket', text: `Reported a problem: ${ISSUES[t.issueType] || t.issueType} (ticket #${t.ticketNumber})`, detail: '' });
    if (t.resolvedAt) events.push({ at: t.resolvedAt, kind: 'resolved', text: `Ticket #${t.ticketNumber} resolved`, detail: '' });
  }
  for (const a of alerts) {
    const title = a.variantTitle ? `${a.productTitle} (${a.variantTitle})` : a.productTitle;
    events.push({ at: a.createdAt, kind: 'restock', text: `Asked to know when ${title} is back`, detail: a.sentAt ? 'Told them it was back' : '' });
  }
  if (customer && customer.optedInAt) {
    events.push({ at: customer.optedInAt, kind: 'optin', text: 'Started getting offers', detail: OPT_IN_SOURCES[customer.optInSource] || '' });
  }
  if (customer && customer.optedOutAt) events.push({ at: customer.optedOutAt, kind: 'optout', text: 'Stopped offers', detail: '' });

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { events: events.slice(0, limit), more: events.length > limit };
}

module.exports = { timeline, chatDays };
