// Notifications on the team's phones and computers (Web Push): new customer
// messages, new tickets, COD cancel requests, due reminders and birthdays,
// tickets waiting too long. Keys are made once and kept in the database, so
// there's nothing to set up.
const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const Order = require('../models/Order');
const settings = require('./settings');

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

let keysPromise = null;
function vapidKeys() {
  if (!keysPromise) {
    keysPromise = (async () => {
      let keys = await settings.get('push:vapid', null);
      if (!keys || !keys.publicKey) {
        keys = webpush.generateVAPIDKeys();
        await settings.set('push:vapid', keys);
      }
      const subject = process.env.PUSH_CONTACT || 'mailto:hello@thakarkitchen.com';
      webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
      return keys;
    })().catch((err) => {
      keysPromise = null;
      throw err;
    });
  }
  return keysPromise;
}

async function publicKey() {
  return (await vapidKeys()).publicKey;
}

async function subscribe(user, sub, device = '') {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw Object.assign(new Error('This browser sent an unusable subscription'), { status: 400, expose: true });
  }
  await PushSubscription.updateOne(
    { endpoint: sub.endpoint },
    { $set: { keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, userId: String(user._id), userName: user.name, device: String(device).slice(0, 200) } },
    { upsert: true }
  );
}

async function unsubscribe(endpoint) {
  await PushSubscription.deleteOne({ endpoint: String(endpoint || '') });
}

// The same alert (e.g. one chat) at most once a minute, so a customer sending
// five messages in a row is one notification, not five.
const recent = new Map();
const REPEAT_MS = 60 * 1000;

// payload: { title, body, url, tag }. who: { userId } to send to one person.
async function send(payload, who = {}) {
  if (payload.tag && !who.userId) {
    const last = recent.get(payload.tag);
    if (last && Date.now() - last < REPEAT_MS) return { sent: 0, throttled: true };
    recent.set(payload.tag, Date.now());
    if (recent.size > 500) recent.clear();
  }
  await vapidKeys();
  const subs = await PushSubscription.find(who.userId ? { userId: String(who.userId) } : {}).lean();
  let sent = 0;
  const body = JSON.stringify({ title: payload.title, body: payload.body || '', url: payload.url || '/', tag: payload.tag || undefined });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 60 * 60, urgency: 'high' });
        sent++;
        await PushSubscription.updateOne({ _id: s._id }, { $set: { lastSentAt: new Date() } });
      } catch (err) {
        // Gone: the person turned notifications off or reinstalled.
        if (err.statusCode === 404 || err.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id });
        else console.error('[push] failed', err.statusCode || '', err.message);
      }
    })
  );
  return { sent, devices: subs.length };
}

async function nameOf(phone) {
  const c = await Customer.findOne({ phone }).select('name').lean();
  return (c && c.name) || `+${phone}`;
}

// After a customer's message is handled: tell the team if it needs someone.
async function afterInbound(phone, since) {
  const conversation = await Conversation.findOne({ customerPhone: phone }).lean();
  if (!conversation || !conversation.unread) return null;
  const fresh = await Message.findOne({ conversationId: conversation._id, direction: 'inbound', createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
  if (!fresh) return null; // a repeat delivery of a message already handled
  const who = await nameOf(phone);
  const url = `/#/inbox/${conversation._id}`;
  const cancel = await Order.findOne({ phone, 'cod.status': 'cancel_requested', 'cod.answeredAt': { $gte: since } }).select('name').lean();
  if (cancel) {
    return send({ title: `${who} wants to cancel ${cancel.name}`, body: 'COD order: cancel it in Shopify before it ships.', url: '/#/orders/cancel_requested', tag: `cod-${cancel.name}` });
  }
  const ticket = conversation.activeTicketId ? await Ticket.findById(conversation.activeTicketId).lean() : null;
  if (ticket && ticket.createdAt >= since) {
    return send({ title: `New ticket #${ticket.ticketNumber} · ${ISSUES[ticket.issueType] || ticket.issueType}`, body: `${who}: ${conversation.lastMessagePreview || ''}`, url, tag: `chat-${conversation._id}` });
  }
  return send({ title: who, body: conversation.lastMessagePreview || 'New message', url, tag: `chat-${conversation._id}` });
}

// Every few minutes: reminders that are now due, and (once each morning)
// today's birthdays.
async function remindersDue(now = new Date()) {
  const due = await Customer.find({
    followUpAt: { $ne: null, $lte: now },
    $expr: { $or: [{ $eq: [{ $ifNull: ['$followUpNotifiedAt', null] }, null] }, { $lt: ['$followUpNotifiedAt', '$followUpAt'] }] },
  })
    .limit(50)
    .select('phone name followUpAt followUpNote')
    .lean();
  for (const c of due) {
    await send({ title: `Reminder: ${c.name || `+${c.phone}`}`, body: c.followUpNote || 'Follow up with them today.', url: `/#/customers/${c.phone}`, tag: `fu-${c.phone}` });
    await Customer.updateOne({ _id: c._id }, { $set: { followUpNotifiedAt: new Date() } });
  }
  let birthdays = 0;
  const india = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = india.toISOString().slice(0, 10);
  if (india.getUTCHours() >= 10) {
    const done = await settings.get('push:birthdays', {});
    if (done.day !== today) {
      await settings.set('push:birthdays', { day: today });
      const list = await Customer.find({ birthday: today.slice(5) }).limit(20).select('phone name').lean();
      birthdays = list.length;
      if (list.length) {
        const names = list.map((c) => c.name || `+${c.phone}`);
        await send({ title: list.length === 1 ? `Birthday today: ${names[0]}` : `${list.length} birthdays today`, body: list.length === 1 ? 'Send them a wish on WhatsApp.' : names.join(', '), url: list.length === 1 ? `/#/customers/${list[0].phone}` : '/#/home', tag: `bday-${today}` });
      }
    }
  }
  return { reminders: due.length, birthdays };
}

async function ticketOverdue(ticket, hours) {
  const who = await nameOf(ticket.customerPhone);
  return send({ title: `Ticket #${ticket.ticketNumber} has waited ${hours}+ hours`, body: `${who} · ${ISSUES[ticket.issueType] || ticket.issueType}`, url: `/#/inbox/${ticket.conversationId}`, tag: `overdue-${ticket._id}` });
}

module.exports = { publicKey, subscribe, unsubscribe, send, afterInbound, remindersDue, ticketOverdue };
