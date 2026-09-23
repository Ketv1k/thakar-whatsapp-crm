// Only mounted when TEST_MODE=true. Lets the founder try the whole support flow
// before WhatsApp is connected: "send" a message as any customer and see what
// the real pipeline does with it. Outgoing replies are never sent in test mode.
const crypto = require('crypto');
const express = require('express');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const shopify = require('../services/shopify');
const deliveryStatus = require('../services/deliveryStatus');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const AbandonedCheckout = require('../models/AbandonedCheckout');
const StockAlert = require('../models/StockAlert');
const automations = require('../services/automations');
const orderSync = require('../services/orderSync');
const cartRecovery = require('../services/cartRecovery');
const reorder = require('../services/reorder');
const backInStock = require('../services/backInStock');
const { handleIncomingMessage } = require('./webhook');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const PHONE_RE = /^[0-9]{8,15}$/;

// Real Shopify customers to pretend to be. Empty list if Shopify is unreachable,
// so the founder can still type a number by hand.
router.get('/customers', asyncHandler(async (req, res) => {
  try {
    res.json(await shopify.listRecentCustomersWithPhone(15));
  } catch (err) {
    console.error('[test mode] could not load Shopify customers', err.message);
    res.json([]);
  }
}));

router.post('/simulate', asyncHandler(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const name = String(req.body.name || '').trim().slice(0, 80);
  const type = ['image', 'audio'].includes(req.body.type) ? req.body.type : 'text';
  const text = String(req.body.text || '').trim().slice(0, 1000);

  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Enter a phone number with country code, e.g. 919876543210' });
  }
  if (type === 'text' && !text) return res.status(400).json({ error: 'Type a message first' });

  const before = await Conversation.findOne({ customerPhone: phone }).lean();
  const startedAt = new Date();

  // A customer who writes back has seen your earlier replies: turn their
  // ticks blue the same way WhatsApp's "read" updates would.
  if (before) {
    const unread = await Message.find({ conversationId: before._id, direction: 'outbound', status: { $in: ['sent', 'delivered'] } })
      .select('waMessageId')
      .lean();
    for (const m of unread) {
      if (m.waMessageId) await deliveryStatus.applyStatus({ id: m.waMessageId, status: 'read' });
    }
  }

  // Same shape Meta sends for each kind of message.
  const media = {
    text: { text: { body: text } },
    // A photo's caption is whatever was typed in the message box, if anything.
    image: { image: { id: 'test-image', mime_type: 'image/svg+xml', ...(text ? { caption: text } : {}) } },
    audio: { audio: { id: 'test-voice', mime_type: 'audio/wav', voice: true } },
  }[type];

  // Run through the exact same handler as a real webhook.
  await handleIncomingMessage(
    { from: phone, id: `wamid.TEST.${crypto.randomUUID()}`, type, ...media },
    { contacts: [{ profile: { name } }] }
  );

  const after = await Conversation.findOne({ customerPhone: phone }).lean();
  const replies = after
    ? await Message.find({ conversationId: after._id, direction: 'outbound', createdAt: { $gte: startedAt } })
        .sort({ createdAt: 1 })
        .lean()
    : [];
  const ticket = after?.activeTicketId ? await Ticket.findById(after.activeTicketId).lean() : null;

  let outcome = 'chat';
  if (ticket && before?.activeTicketId && String(before.activeTicketId) === String(ticket._id)) {
    outcome = 'added_to_ticket';
  } else if (ticket) {
    outcome = 'ticket_created';
  } else if (replies.some((r) => r.autoAck === 'order_status')) {
    outcome = 'auto_answered';
  } else if (replies.some((r) => r.autoAck === 'ai_answer')) {
    outcome = 'ai_answered';
  } else if (replies.length) {
    outcome = 'acknowledged';
  }

  res.json({
    outcome,
    conversationId: after?._id || null,
    ticketId: ticket?._id || null,
    ticketNumber: ticket?.ticketNumber || null,
    issueType: ticket?.issueType || null,
    replies: replies.map((r) => r.body),
  });
}));

// ---- Automations, without Shopify or WhatsApp ----
// Each simulator runs the real automation code on a pretend order / cart /
// request that exists only in this app, and reports what the customer would
// receive (or why nothing was sent).

function readCustomer(body) {
  const phone = String(body.phone || '').replace(/\D/g, '');
  const name = String(body.name || '').trim().slice(0, 80);
  if (!PHONE_RE.test(phone)) {
    throw Object.assign(new Error('Enter a phone number with country code, e.g. 919876543210'), { status: 400, expose: true });
  }
  return { phone, name };
}

async function ensureCustomer({ phone, name }, optIn) {
  await Customer.updateOne({ phone }, { $setOnInsert: { phone, name } }, { upsert: true });
  if (optIn) {
    await Customer.updateOne(
      { phone, optedInMarketing: { $ne: true } },
      { $set: { optedInMarketing: true, optInSource: 'manual', optedInAt: new Date(), optedOutAt: null } }
    );
  }
}

// What the customer received since `since`, and their chat.
async function whatWasSent(phone, since) {
  const conversation = await Conversation.findOne({ customerPhone: phone }).lean();
  if (!conversation) return { conversationId: null, replies: [] };
  const messages = await Message.find({ conversationId: conversation._id, direction: 'outbound', createdAt: { $gte: since } })
    .sort({ createdAt: 1 })
    .lean();
  return {
    conversationId: conversation._id,
    replies: messages.map((m) => ({ body: m.body, buttons: m.buttons || [], kind: m.autoAck, failed: m.status === 'failed' ? m.statusError : null })),
  };
}

const TEST_ITEMS = [
  { title: 'Kaju Curry', quantity: 1 },
  { title: 'Dal Tadka', quantity: 2 },
];
let testOrderNumber = 0;

router.get('/orders', asyncHandler(async (req, res) => {
  const orders = await Order.find({ simulated: true }).sort({ placedAt: -1 }).limit(10).lean();
  res.json(orders.map((o) => ({ _id: o._id, name: o.name, customerName: o.customerName, phone: o.phone, isCod: o.isCod, cod: o.cod, shippedAt: o.shippedAt, outForDeliveryAt: o.outForDeliveryAt, deliveredAt: o.deliveredAt, placedAt: o.placedAt })));
}));

// A pretend order placed just now (prepaid, or COD with ₹99 paid online).
router.post('/order', asyncHandler(async (req, res) => {
  const who = readCustomer(req.body);
  await ensureCustomer(who, false);
  const isCod = req.body.cod === true;
  const total = Math.max(1, Math.min(100000, Math.round(Number(req.body.total) || 640)));
  const since = new Date();
  testOrderNumber = testOrderNumber || (await Order.countDocuments({ simulated: true })) + 1;
  const order = await Order.create({
    shopifyId: `test:${crypto.randomUUID()}`,
    name: `#TEST-${testOrderNumber++}`,
    phone: who.phone,
    firstName: who.name.split(' ')[0] || '',
    customerName: who.name,
    placedAt: since,
    simulated: true,
    total,
    outstanding: isCod ? Math.max(0, total - 99) : 0,
    currency: 'INR',
    financialStatus: isCod ? 'PARTIALLY_PAID' : 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    gateways: ['Razorpay'],
    tags: isCod ? ['razorpay_partial_cod'] : [],
    isCod,
    statusPageUrl: 'https://thakarkitchen.com',
    items: TEST_ITEMS.map((i) => ({ ...i, url: 'https://thakarkitchen.com' })),
  });
  const autos = await automations.getAll();
  const results = await orderSync.processOrder(order, autos);
  res.json({ order: { _id: order._id, name: order.name }, results, off: !Object.keys(results).length, ...(await whatWasSent(who.phone, since)) });
}));

// Moves a pretend order along: shipped -> out for delivery -> delivered.
router.post('/order/:id/advance', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, simulated: true });
  if (!order) return res.status(404).json({ error: 'test order not found' });
  const step = req.body.step;
  const now = new Date();
  const since = new Date();
  if (step === 'shipped') {
    order.shippedAt = now;
    order.fulfillmentStatus = 'FULFILLED';
    order.fulfillments = [{ id: `test:${crypto.randomUUID()}`, createdAt: now, updatedAt: now, displayStatus: 'FULFILLED', trackingUrl: 'https://www.indiapost.gov.in', trackingCompany: 'India Post' }];
  } else if (step === 'out_for_delivery') {
    if (!order.shippedAt) order.shippedAt = now;
    order.outForDeliveryAt = now;
  } else if (step === 'delivered') {
    if (!order.shippedAt) order.shippedAt = now;
    order.deliveredAt = now;
  } else {
    return res.status(400).json({ error: 'unknown step' });
  }
  await order.save();
  const results = await orderSync.processOrder(order, await automations.getAll());
  res.json({ results, off: !Object.keys(results).length, ...(await whatWasSent(order.phone, since)) });
}));

// The customer taps "Confirm order" or "Cancel order" on a COD request.
router.post('/order/:id/tap', asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, simulated: true });
  if (!order) return res.status(404).json({ error: 'test order not found' });
  if (order.cod.status === 'none') return res.status(400).json({ error: 'No COD confirmation was sent for this order' });
  const confirm = req.body.choice !== 'cancel';
  const since = new Date();
  await handleIncomingMessage(
    {
      from: order.phone,
      id: `wamid.TEST.${crypto.randomUUID()}`,
      type: 'button',
      button: { text: confirm ? 'Confirm order' : 'Cancel order', payload: `COD_${confirm ? 'CONFIRM' : 'CANCEL'}:${order._id}` },
    },
    { contacts: [{ profile: { name: order.customerName } }] }
  );
  const fresh = await Order.findById(order._id).lean();
  res.json({ cod: fresh.cod, ...(await whatWasSent(order.phone, since)) });
}));

// Someone left checkout (1 minute past the reminder delay).
router.post('/cart', asyncHandler(async (req, res) => {
  const who = readCustomer(req.body);
  await ensureCustomer(who, req.body.optIn === true);
  const automation = await automations.get('abandoned_cart');
  const createdAt = new Date(Date.now() - ((automation.options.delayMinutes || 60) + 1) * 60 * 1000);
  const checkout = await AbandonedCheckout.create({
    shopifyId: `test:${crypto.randomUUID()}`,
    phone: who.phone,
    firstName: who.name.split(' ')[0] || '',
    url: 'https://thakarkitchen.com/cart',
    total: 545,
    items: ['Dal Dhokali', 'Kaju Gathiya', 'Methi Thepla'],
    checkoutCreatedAt: createdAt,
    simulated: true,
  });
  const since = new Date();
  const decision = await cartRecovery.remind(checkout, automation, { ignoreQuietHours: true });
  res.json({ decision, ...(await whatWasSent(who.phone, since)) });
}));

// An order shipped long enough ago for a reorder reminder.
router.post('/reorder', asyncHandler(async (req, res) => {
  const who = readCustomer(req.body);
  await ensureCustomer(who, req.body.optIn === true);
  const automation = await automations.get('reorder_reminder');
  const shipped = new Date(Date.now() - ((automation.options.days || 21) + 1) * 24 * 60 * 60 * 1000);
  testOrderNumber = testOrderNumber || (await Order.countDocuments({ simulated: true })) + 1;
  const order = await Order.create({
    shopifyId: `test:${crypto.randomUUID()}`,
    name: `#TEST-${testOrderNumber++}`,
    phone: who.phone,
    firstName: who.name.split(' ')[0] || '',
    customerName: who.name,
    placedAt: new Date(shipped.getTime() - 24 * 60 * 60 * 1000),
    shippedAt: shipped,
    simulated: true,
    total: 640,
    currency: 'INR',
    items: [{ title: 'Kaju Curry', quantity: 1, url: 'https://thakarkitchen.com' }],
    notified: { confirmed: shipped, shipped },
  });
  const since = new Date();
  const decision = await reorder.remind(order, automation, { ignoreQuietHours: true });
  res.json({ decision, ...(await whatWasSent(who.phone, since)) });
}));

// A product this customer asked about comes back in stock.
router.post('/restock', asyncHandler(async (req, res) => {
  const who = readCustomer(req.body);
  await ensureCustomer(who, false);
  const automation = await automations.get('back_in_stock');
  if (!automation.enabled) return res.json({ decision: { action: 'wait', reason: 'Automation is off' }, replies: [] });
  const title = String(req.body.product || 'Methi Papad').trim().slice(0, 80) || 'Methi Papad';
  const alert = await StockAlert.create({
    phone: who.phone,
    customerName: who.name,
    productId: 'gid://shopify/Product/0',
    productTitle: title,
    productUrl: 'https://thakarkitchen.com',
    simulated: true,
  });
  const since = new Date();
  const result = await backInStock.sendAlert(alert, { url: 'https://thakarkitchen.com' });
  res.json({ decision: { action: result, reason: result === 'waiting' ? 'Template not approved yet' : '' }, ...(await whatWasSent(who.phone, since)) });
}));

module.exports = router;
