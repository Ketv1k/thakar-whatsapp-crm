// Builds what the inbox shows: the chat list (with search and filters), one
// chat with all its messages, and the Home dashboard numbers. Every customer
// has one conversation; a ticket is a label on it rather than a separate list.
const Conversation = require('../models/Conversation');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const replyWindow = require('./replyWindow');

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
    Customer.find({ phone: { $in: phones } }).select('phone name tags').lean(),
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
  const query = { ...filterQuery(f), ...(await searchQuery(search)) };

  const [rows, all, needsReply, tickets] = await Promise.all([
    Conversation.find(query).sort({ lastMessageAt: -1 }).limit(LIST_LIMIT).lean(),
    Conversation.estimatedDocumentCount(),
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
  return { conversation: item, messages };
}

// India has one time zone and no daylight saving, so "today" is fixed at +5:30.
const IST_OFFSET_MS = 330 * 60 * 1000;
function startOfTodayIndia(now = new Date()) {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

async function dashboard() {
  const today = startOfTodayIndia();
  const slaCutoff = new Date(Date.now() - slaHours() * 60 * 60 * 1000);

  const [openTickets, waitingChats, autoToday, inboundToday, customersToday, ticketsToday, needsReply] = await Promise.all([
    Ticket.find({ status: { $in: ['open', 'founder_replied'] } })
      .sort({ lastActivityAt: 1 })
      .limit(200)
      .lean(),
    Conversation.find({ unread: true, activeTicketId: null }).sort({ lastMessageAt: 1 }).limit(200).lean(),
    Message.aggregate([
      { $match: { direction: 'outbound', autoAck: { $ne: null }, createdAt: { $gte: today } } },
      { $group: { _id: '$autoAck', n: { $sum: 1 } } },
    ]),
    Message.countDocuments({ direction: 'inbound', createdAt: { $gte: today } }),
    Message.distinct('conversationId', { direction: 'inbound', createdAt: { $gte: today } }),
    Ticket.countDocuments({ createdAt: { $gte: today } }),
    Conversation.countDocuments({ unread: true }),
  ]);

  const auto = Object.fromEntries(autoToday.map((r) => [r._id, r.n]));
  const aiAnswers = auto.ai_answer || 0;
  const orderStatus = auto.order_status || 0;
  const ticketAcks = auto.ticket || 0;
  const acknowledgments = Object.entries(auto)
    .filter(([k]) => !['ai_answer', 'order_status', 'ticket'].includes(k))
    .reduce((sum, [, n]) => sum + n, 0);

  const overdue = openTickets.filter((t) => t.lastActivityAt < slaCutoff);
  const waitingOnYou = openTickets.filter((t) => t.status === 'open');

  // Who to look at first: overdue tickets, new tickets, then chats waiting
  // longest. Names are attached in one query at the end.
  const attention = [
    ...overdue.map((t) => ({ kind: 'overdue', ticket: t })),
    ...waitingOnYou.filter((t) => !overdue.includes(t)).map((t) => ({ kind: 'ticket', ticket: t })),
    ...waitingChats.map((c) => ({ kind: 'needs_reply', conversation: c })),
  ].slice(0, 8);

  const phones = attention.map((a) => (a.ticket ? a.ticket.customerPhone : a.conversation.customerPhone));
  const names = new Map(
    (await Customer.find({ phone: { $in: phones } }).select('phone name').lean()).map((c) => [c.phone, c.name])
  );

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
    },
    attention: attention.map((a) => {
      if (a.ticket) {
        return {
          kind: a.kind,
          conversationId: a.ticket.conversationId,
          customerPhone: a.ticket.customerPhone,
          customerName: names.get(a.ticket.customerPhone) || '',
          ticketNumber: a.ticket.ticketNumber,
          issueType: a.ticket.issueType,
          since: a.ticket.lastActivityAt,
        };
      }
      return {
        kind: a.kind,
        conversationId: a.conversation._id,
        customerPhone: a.conversation.customerPhone,
        customerName: names.get(a.conversation.customerPhone) || '',
        preview: a.conversation.lastMessagePreview || '',
        since: a.conversation.lastInboundAt || a.conversation.lastMessageAt,
      };
    }),
    automationsToday: { orderStatus, aiAnswers, acknowledgments, ticketsOpened: ticketsToday, ticketAcks },
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
