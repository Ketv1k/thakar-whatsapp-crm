// Builds what the inbox shows: the chat list (with search and filters), one
// chat with all its messages, and the Home dashboard numbers. Every customer
// has one conversation; a ticket is a label on it rather than a separate list.
const Conversation = require('../models/Conversation');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const Order = require('../models/Order');
const Campaign = require('../models/Campaign');
const replyWindow = require('./replyWindow');
const autoAck = require('./autoAck');
const cartLinks = require('./cartLinks');
const { startOfTodayIndia } = require('../utils/time');

const FILTERS = ['all', 'needs_reply', 'tickets'];
const LIST_LIMIT = 100;

function slaHours() {
  return Number(process.env.SLA_HOURS || 6);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What the founder typed in the search box: a name, a tag, part of a phone
 * number, or a ticket number ("#1042" or "1042"). Pure.
 */
function parseSearch(q) {
  const text = String(q == null ? '' : q).trim().slice(0, 80);
  if (!text) return null;
  const compact = text.replace(/[\s()+-]/g, '');
  const hashNumber = /^#\d{1,7}$/.test(compact);
  const digitsOnly = /^\d{1,15}$/.test(compact);
  return {
    text,
    nameRegex: new RegExp(escapeRegex(text), 'i'),
    ticketNumber: hashNumber || (digitsOnly && compact.length <= 7) ? Number(compact.replace('#', '')) : null,
    phoneDigits: digitsOnly && compact.length >= 3 ? compact : null,
  };
}

// Pure: is a ticket past the reply-time target (same rule as the SLA reminder).
function isOverdue(ticket, now = Date.now()) {
  if (!ticket || ticket.status === 'resolved') return false;
  return now - new Date(ticket.lastActivityAt).getTime() > slaHours() * 60 * 60 * 1000;
}

function filterQuery(filter) {
  if (filter === 'needs_reply') return { unread: true };
  if (filter === 'tickets') return { activeTicketId: { $ne: null } };
  return {};
}

async function searchQuery(search) {
  if (!search) return {};
  const or = [];
  const customers = await Customer.find({ $or: [{ name: search.nameRegex }, { tags: search.nameRegex }] })
    .select('phone')
    .limit(500)
    .lean();
  if (customers.length) or.push({ customerPhone: { $in: customers.map((c) => c.phone) } });
  if (search.phoneDigits) or.push({ customerPhone: { $regex: escapeRegex(search.phoneDigits) } });
  if (search.ticketNumber) {
    const tickets = await Ticket.find({ ticketNumber: search.ticketNumber }).select('conversationId').lean();
    if (tickets.length) or.push({ _id: { $in: tickets.map((t) => t.conversationId) } });
  }
  // Nothing can match: an impossible condition keeps the result empty.
  return or.length ? { $or: or } : { _id: null };
}

// Adds name, tags, the open ticket, the reply window and the latest message
// (for "AI answered" labels and delivery ticks) to lean conversations.
async function decorate(conversations) {
  if (conversations.length === 0) return [];
  await replyWindow.backfillLastInbound(conversations);

  const phones = [...new Set(conversations.map((c) => c.customerPhone))];
  const ticketIds = conversations.map((c) => c.activeTicketId).filter(Boolean);
  const [customers, tickets, lastMessages] = await Promise.all([
    Customer.find({ phone: { $in: phones } }).select('phone name tags status').lean(),
    ticketIds.length
      ? Ticket.find({ _id: { $in: ticketIds } }).select('ticketNumber issueType status lastActivityAt').lean()
      : [],
    Message.aggregate([
      { $match: { conversationId: { $in: conversations.map((c) => c._id) } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$conversationId',
          direction: { $first: '$direction' },
          autoAck: { $first: '$autoAck' },
          sentByFounder: { $first: '$sentByFounder' },
          status: { $first: '$status' },
        },
      },
    ]),
  ]);
  const customerByPhone = new Map(customers.map((c) => [c.phone, c]));
  const ticketById = new Map(tickets.map((t) => [String(t._id), t]));
  const lastById = new Map(lastMessages.map((m) => [String(m._id), m]));

  return conversations.map((c) => {
    const customer = customerByPhone.get(c.customerPhone) || {};
    const ticket = c.activeTicketId ? ticketById.get(String(c.activeTicketId)) : null;
    const last = lastById.get(String(c._id)) || null;
    return {
      _id: c._id,
      customerPhone: c.customerPhone,
      customerName: customer.name || '',
      tags: customer.tags || [],
      vip: customer.status === 'vip',
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview || '',
      needsReply: !!c.unread,
      lastInboundAt: c.lastInboundAt || null,
      windowClosesAt: replyWindow.windowClosesAt(c.lastInboundAt),
      ticket: ticket ? { ...ticket, overdue: isOverdue(ticket) } : null,
      last: last
        ? { direction: last.direction, autoAck: last.autoAck || null, sentByFounder: !!last.sentByFounder, status: last.status || null }
        : null,
    };
  });
}

async function listConversations({ filter = 'all', q = '' } = {}) {
  const f = FILTERS.includes(filter) ? filter : 'all';
  const search = parseSearch(q);
  // Chats with only automatic messages (the customer never wrote) stay out
  // of the list; a search still finds them.
  const visible = search ? {} : { outboundOnly: { $ne: true } };
  const query = { ...visible, ...filterQuery(f), ...(await searchQuery(search)) };

  const [rows, all, needsReply, tickets] = await Promise.all([
    Conversation.find(query).sort({ lastMessageAt: -1 }).limit(LIST_LIMIT).lean(),
    Conversation.countDocuments({ outboundOnly: { $ne: true } }),
    Conversation.countDocuments({ unread: true }),
    Conversation.countDocuments({ activeTicketId: { $ne: null } }),
  ]);
  return { items: await decorate(rows), counts: { all, needs_reply: needsReply, tickets } };
}

async function getConversation(id) {
  const conversation = await Conversation.findById(id).lean();
  if (!conversation) return null;
  const [item] = await decorate([conversation]);
  const messages = await Message.find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(500)
    .select('-__v')
    .lean();
  // Only what the inbox needs to show a file; WhatsApp's media id stays server-side.
  for (const m of messages) {
    if (m.media) m.media = { mimeType: m.media.mimeType || '', filename: m.media.filename || '', voice: !!m.media.voice };
  }
  await attachCartOrders(conversation.customerPhone, messages);
  return { conversation: item, messages };
}

// For cart links sent in the chat: the order that came from each one
// (see cartLinks.matchOrders).
async function attachCartOrders(phone, messages) {
  const carts = messages.filter((m) => m.cart && m.cart.id);
  if (!carts.length) return;
  const orders = await Order.find({
    cancelledAt: null,
    $or: [{ waCartId: { $in: carts.map((m) => m.cart.id) } }, { phone, placedAt: { $gte: new Date(carts[0].createdAt) } }],
  })
    .select('name placedAt total waCartId')
    .lean();
  cartLinks.matchOrders(carts, orders).forEach((match, i) => {
    if (!match) return;
    const o = match.order;
    carts[i].cart.order = { name: o.name, placedAt: o.placedAt, total: o.total, exact: match.exact };
  });
}

const ORDER_UPDATE_KINDS = ['order_confirmed', 'cod_request', 'order_shipped', 'out_for_delivery', 'order_delivered'];
const HOUR = 60 * 60 * 1000;

async function lastCampaignSummary() {
  const c = await Campaign.findOne({ status: { $in: ['sent', 'sending'] } }).sort({ startedAt: -1 });
  if (!c) return null;
  const stats = await require('./campaigns').stats(c);
  return { _id: c._id, name: c.name, status: c.status, startedAt: c.startedAt, ...stats };
}

async function dashboard() {
  const today = startOfTodayIndia();
  const slaCutoff = new Date(Date.now() - slaHours() * HOUR);
  const codWaiting = { isCod: true, 'cod.status': 'awaiting', cancelledAt: null, shippedAt: null };
  const endOfToday = new Date(today.getTime() + 24 * HOUR);
  const monthDay = new Date(Date.now() + 5.5 * HOUR).toISOString().slice(5, 10); // today in India, 'MM-DD'

  const [openTickets, waitingChats, autoToday, inboundToday, customersToday, ticketsToday, needsReply, codOrders, codCancels, lastCampaign, followUps, birthdays] =
    await Promise.all([
      Ticket.find({ status: { $in: ['open', 'founder_replied'] } })
        .sort({ lastActivityAt: 1 })
        .limit(200)
        .lean(),
      Conversation.find({ unread: true, activeTicketId: null }).sort({ lastMessageAt: 1 }).limit(200).lean(),
      Message.aggregate([
        { $match: { direction: 'outbound', autoAck: { $ne: null }, createdAt: { $gte: today }, status: { $ne: 'failed' } } },
        { $group: { _id: '$autoAck', n: { $sum: 1 } } },
      ]),
      Message.countDocuments({ direction: 'inbound', createdAt: { $gte: today } }),
      Message.distinct('conversationId', { direction: 'inbound', createdAt: { $gte: today } }),
      Ticket.countDocuments({ createdAt: { $gte: today } }),
      Conversation.countDocuments({ unread: true }),
      Order.find(codWaiting).sort({ 'cod.requestedAt': 1 }).limit(200).lean(),
      Order.find({ isCod: true, 'cod.status': 'cancel_requested', cancelledAt: null, shippedAt: null }).sort({ 'cod.answeredAt': 1 }).limit(20).lean(),
      lastCampaignSummary(),
      Customer.find({ followUpAt: { $ne: null, $lt: endOfToday } }).sort({ followUpAt: 1 }).limit(20).select('phone name followUpAt followUpNote').lean(),
      Customer.find({ birthday: monthDay }).limit(10).select('phone name birthday').lean(),
    ]);

  const auto = Object.fromEntries(autoToday.map((r) => [r._id, r.n]));
  const aiAnswers = auto.ai_answer || 0;
  const orderStatus = auto.order_status || 0;
  const ticketAcks = auto.ticket || 0;
  const acknowledgments = autoAck.CATEGORIES.reduce((sum, k) => sum + (auto[k] || 0), 0);
  const orderUpdates = ORDER_UPDATE_KINDS.reduce((sum, k) => sum + (auto[k] || 0), 0);

  const overdue = openTickets.filter((t) => t.lastActivityAt < slaCutoff);
  const waitingOnYou = openTickets.filter((t) => t.status === 'open');
  const codStale = codOrders.filter((o) => o.cod.requestedAt && Date.now() - new Date(o.cod.requestedAt).getTime() > 3 * HOUR);

  // Who to look at first: cancel requests (before the order ships), overdue
  // tickets, new tickets, COD orders nobody confirmed, then chats waiting
  // longest. Names are attached in one query at the end.
  const phoneOf = (a) =>
    a.ticket ? a.ticket.customerPhone : a.order ? a.order.phone : a.customer ? a.customer.phone : a.conversation.customerPhone;
  // One line per customer: the most urgent reason wins.
  const seen = new Set();
  const attention = [
    ...codCancels.map((o) => ({ kind: 'cod_cancel', order: o })),
    ...overdue.map((t) => ({ kind: 'overdue', ticket: t })),
    ...waitingOnYou.filter((t) => !overdue.includes(t)).map((t) => ({ kind: 'ticket', ticket: t })),
    ...followUps.map((c) => ({ kind: 'follow_up', customer: c })),
    ...codStale.map((o) => ({ kind: 'cod_waiting', order: o })),
    ...waitingChats.map((c) => ({ kind: 'needs_reply', conversation: c })),
    ...birthdays.map((c) => ({ kind: 'birthday', customer: c })),
  ]
    .filter((a) => {
      const phone = phoneOf(a);
      if (seen.has(phone)) return false;
      seen.add(phone);
      return true;
    })
    .slice(0, 10);

  const phones = attention.map(phoneOf);
  const [names, chats] = await Promise.all([
    Customer.find({ phone: { $in: phones } }).select('phone name').lean(),
    Conversation.find({ customerPhone: { $in: phones } }).select('customerPhone').lean(),
  ]);
  const nameByPhone = new Map(names.map((c) => [c.phone, c.name]));
  const chatByPhone = new Map(chats.map((c) => [c.customerPhone, c._id]));

  return {
    needsReply,
    kpis: {
      tickets: { open: openTickets.length, waitingOnYou: waitingOnYou.length, overdue: overdue.length },
      chatsWaiting: {
        count: waitingChats.length,
        oldestSince: waitingChats.length ? waitingChats[0].lastInboundAt || waitingChats[0].lastMessageAt : null,
      },
      answeredForYou: { total: aiAnswers + orderStatus, ai: aiAnswers, orderStatus },
      messagesToday: { count: inboundToday, customers: customersToday.length },
      cod: {
        waiting: codOrders.length,
        atStake: Math.round(codOrders.reduce((s, o) => s + (o.outstanding > 0 ? o.outstanding : o.total || 0), 0)),
        cancelRequests: codCancels.length,
      },
    },
    attention: attention.map((a) => {
      const phone = phoneOf(a);
      const base = {
        kind: a.kind,
        customerPhone: phone,
        customerName: nameByPhone.get(phone) || (a.order && a.order.customerName) || '',
        conversationId: chatByPhone.get(phone) || null,
      };
      if (a.ticket) {
        return { ...base, ticketNumber: a.ticket.ticketNumber, issueType: a.ticket.issueType, since: a.ticket.lastActivityAt };
      }
      if (a.kind === 'follow_up') return { ...base, note: a.customer.followUpNote || '', since: a.customer.followUpAt };
      if (a.kind === 'birthday') return { ...base, since: null };
      if (a.order) {
        const amount = a.order.outstanding > 0 ? a.order.outstanding : a.order.total;
        return {
          ...base,
          orderId: a.order._id,
          orderName: a.order.name,
          amount,
          currency: a.order.currency,
          since: a.kind === 'cod_cancel' ? a.order.cod.answeredAt : a.order.cod.requestedAt,
        };
      }
      return { ...base, preview: a.conversation.lastMessagePreview || '', since: a.conversation.lastInboundAt || a.conversation.lastMessageAt };
    }),
    automationsToday: {
      orderStatus,
      aiAnswers,
      acknowledgments,
      ticketsOpened: ticketsToday,
      ticketAcks,
      orderUpdates,
      codReplies: auto.cod_reply || 0,
      cartReminders: auto.cart_reminder || 0,
      reorderReminders: auto.reorder_reminder || 0,
      backInStock: auto.back_in_stock || 0,
    },
    lastCampaign,
  };
}

module.exports = {
  listConversations,
  getConversation,
  dashboard,
  parseSearch,
  isOverdue,
  startOfTodayIndia,
  FILTERS,
};
