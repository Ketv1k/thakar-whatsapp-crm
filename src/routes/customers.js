const express = require('express');
const QRCode = require('qrcode');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const StockAlert = require('../models/StockAlert');
const Ticket = require('../models/Ticket');
const Group = require('../models/Group');
const AbandonedCheckout = require('../models/AbandonedCheckout');
const shopify = require('../services/shopify');
const customerStatus = require('../services/customerStatus');
const customerInsights = require('../services/customerInsights');
const customerTimeline = require('../services/customerTimeline');
const contactImport = require('../services/contactImport');
const shopifyLive = require('../services/shopifyLive');
const consent = require('../services/consent');
const segments = require('../services/segments');
const settings = require('../services/settings');
const { cleanTags } = require('../services/tags');
const { normalizePhone } = require('../utils/phone');
const { asyncHandler } = require('../utils/asyncHandler');
const { ownerOnly } = require('../middleware/auth');

const router = express.Router();

// Phone numbers are stored digits-only; guard against odd input.
const PHONE_RE = /^[0-9]{6,15}$/;
const ID_RE = /^[a-f0-9]{24}$/;
const PAGE_SIZE = 50;
// Prefilled message for the "get offers" link; optIn.js treats it like START.
const OPT_IN_TEXT = 'Yes, send me offers';

// The group, filters and search a request asks for. A saved group (?group=)
// brings its own stage and filters.
async function audienceOf(src) {
  let segment = segments.isSegment(src.segment) ? src.segment : 'all';
  let filters = segments.cleanFilters(src.filters);
  let group = null;
  if (ID_RE.test(String(src.group || ''))) {
    group = await Group.findById(src.group).lean();
    if (group) {
      segment = segments.isSegment(group.segment) ? group.segment : 'all';
      filters = { ...segments.cleanFilters(group.filters), ...filters };
    }
  }
  const tag = String(src.tag || '').slice(0, 30);
  return { segment, filters, tag, group };
}

// The customer directory: every customer from Shopify plus everyone who has
// messaged, by stage or saved group, narrowed by filters and search text.
router.get('/', asyncHandler(async (req, res) => {
  const { segment, filters, tag, group } = await audienceOf(req.query);
  const q = String(req.query.q || '').slice(0, 60);
  const page = Math.max(0, Math.min(1000, Number(req.query.page) || 0));
  const filter = segments.customerFilter({ segment, tag, q, filters });

  const [items, total, counts, tags, groups, sync, history] = await Promise.all([
    Customer.find(filter)
      .sort({ lastOrderAt: -1, updatedAt: -1 })
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .select('phone name city state status ordersCount totalSpent currency lastOrderAt tags optedInMarketing optInSource followUpAt')
      .lean(),
    Customer.countDocuments(filter),
    segments.counts({ tag, filters }),
    Customer.distinct('tags'),
    Group.find().sort({ name: 1 }).lean(),
    settings.get('sync:customers', {}),
    settings.get('sync:history', {}),
  ]);
  const chats = await Conversation.find({ customerPhone: { $in: items.map((c) => c.phone) } })
    .select('customerPhone')
    .lean();
  const chatByPhone = new Map(chats.map((c) => [c.customerPhone, String(c._id)]));
  const [optedIn, allCustomers, allOptedIn, groupCounts] = await Promise.all([
    Customer.countDocuments({ $and: [filter, { optedInMarketing: true }] }),
    Customer.estimatedDocumentCount(),
    Customer.countDocuments({ optedInMarketing: true }),
    Promise.all(groups.map((g) => Customer.countDocuments(segments.customerFilter({ segment: g.segment, filters: g.filters })))),
  ]);
  const now = new Date();

  res.json({
    items: items.map((c) => ({
      ...c,
      stage: segments.stageOf(c, now),
      conversationId: chatByPhone.get(c.phone) || null,
    })),
    total,
    optedIn,
    // Everyone, whatever is picked (for the line under the title).
    totals: { customers: allCustomers, optedIn: allOptedIn },
    page,
    pageSize: PAGE_SIZE,
    segment,
    filters,
    describe: segments.describeFilters(filters),
    group: group ? { _id: group._id, name: group.name } : null,
    counts,
    segments: segments.SEGMENTS,
    groups: groups.map((g, i) => ({ ...groupOut(g), count: groupCounts[i] })),
    tags: tags.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    sync: {
      lastRunAt: sync.lastRunAt || null,
      total: sync.total || null,
      importing: !!sync.cursor,
      lastError: sync.lastError || null,
      historyDone: !!history.done,
    },
    shopifyConnected: shopify.isConfigured(),
  });
}));

// Everything customers have bought, for the "Bought" filter.
router.get('/products', asyncHandler(async (req, res) => {
  res.json(await customerInsights.productList());
}));

// ---------- Saved groups ----------
function groupOut(g) {
  const stage = segments.stageLabel(g.segment);
  const filters = segments.cleanFilters(g.filters);
  return {
    _id: g._id,
    name: g.name,
    segment: g.segment,
    filters,
    describe: [g.segment !== 'all' ? stage : '', segments.describeFilters(filters)].filter(Boolean).join(' · '),
  };
}

router.get('/groups', asyncHandler(async (req, res) => {
  res.json((await Group.find().sort({ name: 1 }).lean()).map(groupOut));
}));

router.post('/groups', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the group a name' });
  const segment = segments.isSegment(req.body.segment) ? req.body.segment : 'all';
  const filters = segments.cleanFilters(req.body.filters);
  if (segment === 'all' && !Object.keys(filters).length) return res.status(400).json({ error: 'Pick a stage or a filter first' });
  const group = await Group.create({ name, segment, filters });
  res.status(201).json(groupOut(group));
}));

router.delete('/groups/:id', asyncHandler(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'group not found' });
  const out = await Group.deleteOne({ _id: req.params.id });
  if (!out.deletedCount) return res.status(404).json({ error: 'group not found' });
  res.json({ ok: true });
}));

// ---------- Export / import ----------
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Also stops a spreadsheet from running a cell as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

router.get('/export', ownerOnly, asyncHandler(async (req, res) => {
  const { segment, filters, tag } = await audienceOf(req.query);
  const q = String(req.query.q || '').slice(0, 60);
  const rows = await Customer.find(segments.customerFilter({ segment, tag, q, filters }))
    .sort({ lastOrderAt: -1 })
    .limit(50000)
    .select('phone name city state pincode ordersCount totalSpent lastOrderAt status tags optedInMarketing products')
    .lean();
  const now = new Date();
  const header = ['Name', 'Phone', 'City', 'State', 'Pincode', 'Stage', 'Orders', 'Spent', 'Last order', 'Gets offers', 'Tags', 'Bought'];
  const lines = [header.join(',')];
  for (const c of rows) {
    lines.push(
      [
        c.name,
        `+${c.phone}`,
        c.city,
        c.state,
        c.pincode,
        segments.stageLabel(segments.stageOf(c, now)),
        c.ordersCount || 0,
        Math.round(c.totalSpent || 0),
        c.lastOrderAt ? new Date(c.lastOrderAt).toISOString().slice(0, 10) : '',
        c.optedInMarketing ? 'Yes' : 'No',
        (c.tags || []).join('; '),
        (c.products || []).join('; '),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="customers-${now.toISOString().slice(0, 10)}.csv"`,
  });
  res.send(`﻿${lines.join('\r\n')}\r\n`);
}));

// Preview (dryRun: true) or apply a CSV import.
router.post('/import', ownerOnly, asyncHandler(async (req, res) => {
  const csv = String(req.body.csv || '');
  if (!csv.trim()) return res.status(400).json({ error: 'Choose a CSV file first' });
  const dryRun = req.body.dryRun !== false;
  const optIn = req.body.optIn === true;
  if (!dryRun && optIn && req.body.confirm !== true) return res.status(400).json({ error: 'Please confirm they agreed first' });
  const evidence = !dryRun && optIn ? consent.bulkEvidence(req.body.reason, `imported from ${String(req.body.fileName || 'a list').slice(0, 60)}`, req.user && req.user.name) : '';
  const out = await contactImport.importList({ csv, optIn, tag: String(req.body.tag || ''), dryRun, evidence, by: req.user && req.user.name });
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));

// ---------- Growing the offers list ----------
async function checkoutConsentPhones() {
  const phones = await AbandonedCheckout.distinct('phone', { whatsappConsent: true, phone: { $ne: null }, simulated: { $ne: true } });
  if (!phones.length) return [];
  const blocked = await Customer.distinct('phone', {
    phone: { $in: phones },
    $or: [{ optedInMarketing: true }, { optedOutAt: { $ne: null } }],
  });
  const skip = new Set(blocked);
  return phones.filter((p) => !skip.has(p));
}

router.get('/grow', asyncHandler(async (req, res) => {
  const [optedIn, shopifyWhatsApp, orderBasis, checkoutPhones, link] = await Promise.all([
    Customer.countDocuments({ optedInMarketing: true }),
    Customer.countDocuments({ optInSource: 'shopify_whatsapp', optedInMarketing: true }),
    consent.orderBasis(),
    checkoutConsentPhones(),
    settings.get('optin:link', {}),
  ]);
  const number = normalizePhone(link.number);
  const url = number ? `https://wa.me/${number}?text=${encodeURIComponent(OPT_IN_TEXT)}` : null;
  res.json({
    optedIn,
    shopifyWhatsApp,
    orderUpdates: orderBasis.mode,
    checkoutConsent: checkoutPhones.length,
    link: { number: number || '', url, qr: url ? await QRCode.toString(url, { type: 'svg', margin: 1 }) : null },
  });
}));

router.put('/grow/link', ownerOnly, asyncHandler(async (req, res) => {
  const number = normalizePhone(req.body.number);
  if (!number) return res.status(400).json({ error: 'Type your WhatsApp business number, e.g. 98765 43210' });
  await settings.set('optin:link', { number });
  res.json({ number });
}));

// Opts in people who ticked the WhatsApp box at checkout (Magic Checkout)
// but didn't finish. Needs an explicit confirm.
router.post('/grow/checkout', ownerOnly, asyncHandler(async (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Please confirm first' });
  const phones = await checkoutConsentPhones();
  const now = new Date();
  const evidence = consent.bulkEvidence(req.body.reason || 'Ticked the WhatsApp box at Magic Checkout', 'added from checkouts', req.user && req.user.name);
  const fields = consent.optInFields({ source: 'checkout', evidence, by: req.user && req.user.name, at: now });
  const ops = phones.map((phone) => ({
    updateOne: {
      filter: { phone, optedOutAt: null, optedInMarketing: { $ne: true }, noWhatsApp: { $ne: true } },
      update: { $set: fields },
    },
  }));
  let changed = 0;
  for (let i = 0; i < ops.length; i += 1000) changed += (await Customer.bulkWrite(ops.slice(i, i + 1000), { ordered: false })).modifiedCount;
  // People who only exist as carts get a customer record too.
  const known = new Set(await Customer.distinct('phone', { phone: { $in: phones } }));
  const missing = phones.filter((p) => !known.has(p));
  if (missing.length) {
    await Customer.insertMany(
      missing.map((phone) => ({ phone, ...fields })),
      { ordered: false }
    ).catch(() => {});
    changed += missing.length;
  }
  res.json({ changed });
}));

// Opt a whole group in to offers at once - for customers who already agreed
// somewhere else (e.g. in Zoko or at checkout). Needs an explicit confirm.
router.post('/bulk-opt-in', ownerOnly, asyncHandler(async (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Please confirm first' });
  const evidence = consent.bulkEvidence(req.body.reason, 'group opt-in', req.user && req.user.name);
  const { segment, filters, tag } = await audienceOf(req.body);
  const result = await Customer.updateMany(
    { $and: [segments.customerFilter({ segment, tag, filters }), { optedInMarketing: { $ne: true } }, { optedOutAt: null }, { noWhatsApp: { $ne: true } }] },
    { $set: consent.optInFields({ source: 'bulk', evidence, by: req.user && req.user.name }) }
  );
  res.json({ changed: result.modifiedCount });
}));

// ---------- One customer ----------
// Full CRM profile for one customer, assembled on demand:
//  - who they are + founder's private note, tags, reminder and birthday
//  - their order history + lifetime spend (live from Shopify)
//  - their stage and the numbers worked out from their orders
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
  const ordersCount = shopifySummary.ordersCount != null ? shopifySummary.ordersCount : customer.ordersCount;
  const totalSpent = shopifySummary.totalSpent != null ? shopifySummary.totalSpent : customer.totalSpent;
  const lastOrderAt = shopifySummary.lastOrderAt || customer.lastOrderAt;
  const stage = segments.stageOf({ ordersCount, lastOrderAt, status }, new Date());

  const [tickets, conversation, codOrders, stockAlerts, localOrders] = await Promise.all([
    Ticket.find({ customerPhone: phone })
      .sort({ lastActivityAt: -1 })
      .limit(50)
      .select('ticketNumber issueType status lastActivityAt resolvedAt')
      .lean(),
    Conversation.findOne({ customerPhone: phone }).select('_id').lean(),
    Order.find({ phone, isCod: true }).sort({ placedAt: -1 }).limit(10).select('name cod outstanding total currency placedAt').lean(),
    StockAlert.find({ phone, status: { $in: ['waiting', 'sent', 'failed'] } }).sort({ createdAt: -1 }).limit(20).lean(),
    Order.find({ phone }).sort({ placedAt: -1 }).limit(5).select('shopifyId name placedAt total currency fulfillmentStatus shippedAt simulated').lean(),
  ]);

  const avgOrder = ordersCount ? Math.round(totalSpent / ordersCount) : null;
  const nextOrderAt = customer.avgGapDays && lastOrderAt ? new Date(new Date(lastOrderAt).getTime() + customer.avgGapDays * 24 * 60 * 60 * 1000) : null;

  res.json({
    phone,
    name: customer.name || shopifySummary.customerName || '',
    notes: customer.notes || '',
    tags: customer.tags || [],
    optedInMarketing: !!customer.optedInMarketing,
    optInSource: customer.optInSource || null,
    optedInAt: customer.optedInAt || null,
    optedOutAt: customer.optedOutAt || null,
    optInEvidence: customer.optInEvidence || '',
    noWhatsApp: !!customer.noWhatsApp,
    orderUpdates: consent.orderUpdatesAllowed(customer, await consent.orderBasis()),
    city: customer.city || '',
    state: customer.state || '',
    pincode: customer.pincode || '',
    status,
    statusLabel: customerStatus.statusLabel(status),
    stage,
    stageLabel: segments.stageLabel(stage),
    insights: {
      avgOrder,
      avgGapDays: customer.avgGapDays || null,
      nextOrderAt,
      codOrders: customer.codOrders || 0,
      prepaidOrders: customer.prepaidOrders || 0,
      codCancelled: customer.codCancelled || 0,
      favourites: customer.favourites || [],
      firstOrderAt: customer.firstOrderAt || null,
    },
    followUpAt: customer.followUpAt || null,
    followUpNote: customer.followUpNote || '',
    birthday: customer.birthday || '',
    shopify: shopifySummary,
    tickets,
    conversationId: conversation ? conversation._id : null,
    cod: Object.fromEntries(codOrders.map((o) => [o.name, { status: o.cod.status, outstanding: o.outstanding, _id: o._id }])),
    // Orders the app has on file: test orders, and a fallback when Shopify
    // can't be reached.
    localOrders: localOrders.map((o) => ({
      id: o.simulated ? null : String(o.shopifyId || '').split('/').pop(),
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

router.get('/:phone/timeline', asyncHandler(async (req, res) => {
  if (!PHONE_RE.test(req.params.phone)) return res.status(400).json({ error: 'invalid phone' });
  const limit = Math.max(10, Math.min(300, Number(req.query.limit) || 30));
  res.json(await customerTimeline.timeline(req.params.phone, limit));
}));

const BIRTHDAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Update the founder-editable bits of a profile (note, tags, marketing
// opt-in, follow-up reminder, birthday).
router.patch('/:phone', asyncHandler(async (req, res) => {
  const phone = req.params.phone;
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid phone' });

  const update = {};
  if (typeof req.body.notes === 'string') update.notes = req.body.notes.slice(0, 2000);
  if (Array.isArray(req.body.tags)) update.tags = cleanTags(req.body.tags);
  if (typeof req.body.optedInMarketing === 'boolean') {
    update.optedInMarketing = req.body.optedInMarketing;
    if (req.body.optedInMarketing) {
      const how = String(req.body.evidence || '').trim();
      if (how.length < 3) return res.status(400).json({ error: 'Say how they agreed to get offers on WhatsApp' });
      Object.assign(update, consent.optInFields({ source: 'manual', evidence: `${how.slice(0, 200)} — recorded by ${req.user ? req.user.name : 'the team'} on ${consent.stamp()}`, by: req.user && req.user.name }));
    } else {
      // Turned off by hand: treat as an opt-out, so a later sync of Shopify
      // consent doesn't switch it back on.
      Object.assign(update, { optInSource: null, optedOutAt: new Date() });
    }
  }
  if (typeof req.body.name === 'string' && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 120);
  if (req.body.followUpAt !== undefined) {
    if (req.body.followUpAt === null || req.body.followUpAt === '') {
      Object.assign(update, { followUpAt: null, followUpNote: '' });
    } else {
      const at = new Date(req.body.followUpAt);
      if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Pick a date for the reminder' });
      update.followUpAt = at;
      update.followUpNote = String(req.body.followUpNote || '').trim().slice(0, 200);
    }
  }
  if (typeof req.body.birthday === 'string') {
    if (req.body.birthday && !BIRTHDAY_RE.test(req.body.birthday)) return res.status(400).json({ error: 'Pick a day and month' });
    update.birthday = req.body.birthday;
  }

  // Tag and note changes on a Shopify customer go to Shopify too.
  const before = await Customer.findOne({ phone }).select('tags notes shopifyCustomerId shopifyPush').lean();
  if (before && before.shopifyCustomerId && (update.tags || update.notes !== undefined)) {
    const had = (before.tags || []).map((t) => t.toLowerCase());
    const now = (update.tags || before.tags || []).map((t) => t.toLowerCase());
    const change = {
      added: update.tags ? update.tags.filter((t) => !had.includes(t.toLowerCase())) : [],
      removed: update.tags ? (before.tags || []).filter((t) => !now.includes(t.toLowerCase())) : [],
    };
    if (update.notes !== undefined && update.notes !== (before.notes || '')) change.note = update.notes;
    if (change.added.length || change.removed.length || change.note !== undefined) {
      update.shopifyPush = shopifyLive.queueChange(before.shopifyPush, change);
    }
  }

  const customer = await Customer.findOneAndUpdate(
    { phone },
    { $set: update, $setOnInsert: { phone } },
    { upsert: true, new: true }
  ).lean();
  const shopifySaved = customer.shopifyPush ? await shopifyLive.pushCustomer(customer) : 'none';

  res.json({
    phone,
    name: customer.name || '',
    notes: customer.notes || '',
    tags: customer.tags || [],
    // 'saved': Shopify has it · 'failed': will retry · 'none': not a Shopify customer / nothing to send
    shopify: shopifySaved,
    optedInMarketing: !!customer.optedInMarketing,
    optInSource: customer.optInSource || null,
    optInEvidence: customer.optInEvidence || '',
    followUpAt: customer.followUpAt || null,
    followUpNote: customer.followUpNote || '',
    birthday: customer.birthday || '',
  });
}));

module.exports = router;
