const express = require('express');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const StockAlert = require('../models/StockAlert');
const Ticket = require('../models/Ticket');
const shopify = require('../services/shopify');
const customerStatus = require('../services/customerStatus');
const segments = require('../services/segments');
const settings = require('../services/settings');
const { cleanTags } = require('../services/tags');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// Phone numbers are stored digits-only; guard against odd input.
const PHONE_RE = /^[0-9]{6,15}$/;
const PAGE_SIZE = 50;

// The customer directory: every customer from Shopify plus everyone who has
// messaged, filtered by group (?segment=), tag and search text (?q=).
router.get('/', asyncHandler(async (req, res) => {
  const segment = segments.isSegment(req.query.segment) ? req.query.segment : 'all';
  const tag = String(req.query.tag || '').slice(0, 30);
  const q = String(req.query.q || '').slice(0, 60);
  const page = Math.max(0, Math.min(1000, Number(req.query.page) || 0));
  const filter = segments.customerFilter({ segment, tag, q });

  const [items, total, counts, tags, sync] = await Promise.all([
    Customer.find(filter)
      .sort({ lastOrderAt: -1, updatedAt: -1 })
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .select('phone name city status ordersCount totalSpent currency lastOrderAt tags optedInMarketing optInSource')
      .lean(),
    Customer.countDocuments(filter),
    segments.counts({ tag }),
    Customer.distinct('tags'),
    settings.get('sync:customers', {}),
  ]);
  const chats = await Conversation.find({ customerPhone: { $in: items.map((c) => c.phone) } })
    .select('customerPhone')
    .lean();
  const chatByPhone = new Map(chats.map((c) => [c.customerPhone, String(c._id)]));
  const optedIn = await Customer.countDocuments({ $and: [filter, { optedInMarketing: true }] });

  res.json({
    items: items.map((c) => ({ ...c, conversationId: chatByPhone.get(c.phone) || null })),
    total,
    optedIn,
    page,
    pageSize: PAGE_SIZE,
    counts,
    segments: segments.SEGMENTS,
    tags: tags.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    sync: { lastRunAt: sync.lastRunAt || null, total: sync.total || null, importing: !!sync.cursor, lastError: sync.lastError || null },
    shopifyConnected: shopify.isConfigured(),
  });
}));

// Opt a whole group in to offers at once - for customers who already agreed
// somewhere else (e.g. in Zoko or at checkout). Needs an explicit confirm.
router.post('/bulk-opt-in', asyncHandler(async (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Please confirm first' });
  const segment = segments.isSegment(req.body.segment) ? req.body.segment : 'all';
  const tag = String(req.body.tag || '').slice(0, 30);
  const result = await Customer.updateMany(
    { $and: [segments.customerFilter({ segment, tag }), { optedInMarketing: { $ne: true } }, { optedOutAt: null }] },
    { $set: { optedInMarketing: true, optInSource: 'bulk', optedInAt: new Date() } }
  );
  res.json({ changed: result.modifiedCount });
}));

// Full CRM profile for one customer, assembled on demand:
//  - who they are + founder's private note and tags (from our DB)
//  - their order history + lifetime spend (live from Shopify)
//  - an automatic New / Returning / VIP status
//  - every past support ticket, COD answers and back-in-stock requests
router.get('/:phone', asyncHandler(async (req, res) => {
  const phone = req.params.phone;
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid phone' });

  // Our own record (name, note, marketing opt-in). Create-on-read so the
  // profile always exists for anyone who has ever messaged.
  const customer = await Customer.findOneAndUpdate(
    { phone },
    { $setOnInsert: { phone } },
    { upsert: true, new: true }
  ).lean();

  // Live Shopify history - degrade gracefully if it's unconfigured or down,
  // so the profile still shows name, note, and ticket history.
  let shopifySummary = { found: false };
  try {
    shopifySummary = await shopify.getCustomerSummaryByPhone(phone);
  } catch (err) {
    console.error('[customers] shopify summary failed', err.message);
    shopifySummary = { found: false, error: true };
  }
  // Fall back to the last synced numbers when Shopify can't be reached.
  if (!shopifySummary.found && customer.ordersCount) {
    Object.assign(shopifySummary, {
      ordersCount: customer.ordersCount,
      totalSpent: customer.totalSpent,
      currency: customer.currency,
      lastOrderAt: customer.lastOrderAt,
      orders: shopifySummary.orders || [],
      fromSync: true,
    });
  }

  const status = customerStatus.classify(shopifySummary.ordersCount, shopifySummary.totalSpent);

  const [tickets, conversation, codOrders, stockAlerts, localOrders] = await Promise.all([
    Ticket.find({ customerPhone: phone })
      .sort({ lastActivityAt: -1 })
      .limit(50)
      .select('ticketNumber issueType status lastActivityAt resolvedAt')
      .lean(),
    Conversation.findOne({ customerPhone: phone }).select('_id').lean(),
    Order.find({ phone, isCod: true }).sort({ placedAt: -1 }).limit(10).select('name cod outstanding total currency placedAt').lean(),
    StockAlert.find({ phone, status: { $in: ['waiting', 'sent', 'failed'] } }).sort({ createdAt: -1 }).limit(20).lean(),
    Order.find({ phone }).sort({ placedAt: -1 }).limit(5).select('name placedAt total currency fulfillmentStatus shippedAt simulated').lean(),
  ]);

  res.json({
    phone,
    name: customer.name || shopifySummary.customerName || '',
    notes: customer.notes || '',
    tags: customer.tags || [],
    optedInMarketing: !!customer.optedInMarketing,
    optInSource: customer.optInSource || null,
    optedInAt: customer.optedInAt || null,
    optedOutAt: customer.optedOutAt || null,
    city: customer.city || '',
    status,
    statusLabel: customerStatus.statusLabel(status),
    shopify: shopifySummary,
    tickets,
    conversationId: conversation ? conversation._id : null,
    cod: Object.fromEntries(codOrders.map((o) => [o.name, { status: o.cod.status, outstanding: o.outstanding, _id: o._id }])),
    // Orders the app has on file: test orders, and a fallback when Shopify
    // can't be reached.
    localOrders: localOrders.map((o) => ({
      name: o.name,
      createdAt: o.placedAt,
      total: o.total,
      fulfillmentStatus: o.shippedAt ? 'FULFILLED' : o.fulfillmentStatus || 'UNFULFILLED',
      simulated: !!o.simulated,
    })),
    shopifyConnected: shopify.isConfigured(),
    stockAlerts,
  });
}));

// Update the founder-editable bits of a profile (note, tags, marketing opt-in).
router.patch('/:phone', asyncHandler(async (req, res) => {
  const phone = req.params.phone;
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid phone' });

  const update = {};
  if (typeof req.body.notes === 'string') update.notes = req.body.notes.slice(0, 2000);
  if (Array.isArray(req.body.tags)) update.tags = cleanTags(req.body.tags);
  if (typeof req.body.optedInMarketing === 'boolean') {
    update.optedInMarketing = req.body.optedInMarketing;
    if (req.body.optedInMarketing) {
      Object.assign(update, { optInSource: 'manual', optedInAt: new Date(), optedOutAt: null });
    } else {
      // Turned off by hand: treat as an opt-out, so a later sync of Shopify
      // consent doesn't switch it back on.
      Object.assign(update, { optInSource: null, optedOutAt: new Date() });
    }
  }
  if (typeof req.body.name === 'string' && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 120);

  const customer = await Customer.findOneAndUpdate(
    { phone },
    { $set: update, $setOnInsert: { phone } },
    { upsert: true, new: true }
  ).lean();

  res.json({
    phone,
    name: customer.name || '',
    notes: customer.notes || '',
    tags: customer.tags || [],
    optedInMarketing: !!customer.optedInMarketing,
    optInSource: customer.optInSource || null,
  });
}));

module.exports = router;
