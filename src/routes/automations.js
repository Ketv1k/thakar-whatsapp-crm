const express = require('express');
const Message = require('../models/Message');
const Order = require('../models/Order');
const AbandonedCheckout = require('../models/AbandonedCheckout');
const StockAlert = require('../models/StockAlert');
const Customer = require('../models/Customer');
const Template = require('../models/Template');
const automations = require('../services/automations');
const templates = require('../services/templates');
const settings = require('../services/settings');
const shopify = require('../services/shopify');
const pricing = require('../services/pricing');
const aiAnswer = require('../services/aiAnswer');
const customerSync = require('../services/customerSync');
const { runJob, isRunning } = require('../jobs/scheduler');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const DAY = 24 * 60 * 60 * 1000;

// Carts abandoned in Shopify this week, asked at most hourly.
let cartCountCache = { at: 0, value: null };
async function cartsAbandonedThisWeek() {
  if (!shopify.isConfigured()) return null;
  if (Date.now() - cartCountCache.at < 60 * 60 * 1000) return cartCountCache.value;
  try {
    const since = new Date(Date.now() - 7 * DAY).toISOString();
    const data = await shopify.graphql(`{ abandonedCheckoutsCount(query: "created_at:>'${since}'", limit: 10000) { count } }`);
    cartCountCache = { at: Date.now(), value: data.abandonedCheckoutsCount.count };
  } catch (err) {
    cartCountCache = { at: Date.now(), value: null };
  }
  return cartCountCache.value;
}

async function sentCount(kind, since) {
  return Message.countDocuments({ autoAck: kind, createdAt: { $gte: since }, status: { $ne: 'failed' } });
}

async function reorderedAfterReminder(since) {
  const reminded = await Order.find({ 'notifyNotes.reorder': 'Sent', 'notified.reorder': { $gte: since } })
    .select('phone notified.reorder')
    .lean();
  let n = 0;
  for (const o of reminded) {
    if (await Order.exists({ phone: o.phone, placedAt: { $gt: o.notified.reorder }, cancelledAt: null })) n++;
  }
  return n;
}

async function stats() {
  const week = new Date(Date.now() - 7 * DAY);
  const [confirmed, shipped, ofd, delivered, codRows, cartsSent, recovered, reorderSent, reordered, stockWaiting, stockSent, abandonedWeek] =
    await Promise.all([
      sentCount('order_confirmed', week),
      sentCount('order_shipped', week),
      sentCount('out_for_delivery', week),
      sentCount('order_delivered', week),
      Order.aggregate([
        { $match: { isCod: true, 'cod.requestedAt': { $gte: week } } },
        { $group: { _id: '$cod.status', n: { $sum: 1 } } },
      ]),
      AbandonedCheckout.countDocuments({ remindStatus: 'sent', remindedAt: { $gte: week } }),
      AbandonedCheckout.find({ recoveredAt: { $gte: week } }).select('recoveredTotal').lean(),
      sentCount('reorder_reminder', week),
      reorderedAfterReminder(new Date(Date.now() - 30 * DAY)),
      StockAlert.countDocuments({ status: 'waiting' }),
      StockAlert.countDocuments({ status: 'sent', sentAt: { $gte: week } }),
      cartsAbandonedThisWeek(),
    ]);
  const cod = Object.fromEntries(codRows.map((r) => [r._id, r.n]));
  return {
    order_confirmed: { sent: confirmed },
    order_shipped: { sent: shipped },
    order_out_for_delivery: { sent: ofd },
    order_delivered: { sent: delivered },
    cod_confirmation: { confirmed: cod.confirmed || 0, cancelRequested: cod.cancel_requested || 0, waiting: cod.awaiting || 0 },
    abandoned_cart: {
      sent: cartsSent,
      recovered: recovered.length,
      recoveredValue: Math.round(recovered.reduce((s, c) => s + (c.recoveredTotal || 0), 0)),
      abandonedThisWeek: abandonedWeek,
    },
    reorder_reminder: { sent: reorderSent, reordered },
    back_in_stock: { waiting: stockWaiting, sent: stockSent },
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const [autos, templateDocs, weekStats, optin, subscribed, optedIn, syncOrders, syncCustomers, jobs] = await Promise.all([
    automations.getAll(),
    Template.find({ source: 'catalog' }),
    stats(),
    settings.get('optin:shopify', {}),
    Customer.countDocuments({ marketingConsent: 'SUBSCRIBED' }),
    Customer.countDocuments({ optedInMarketing: true }),
    settings.get('sync:orders', {}),
    settings.get('sync:customers', {}),
    Promise.all(['orders', 'carts', 'stock', 'reorder', 'customers'].map((j) => settings.get(`job:${j}`, {}))),
  ]);
  const byName = new Map(templateDocs.map((t) => [t.name, templates.summary(t)]));
  const list = {};
  for (const [key, a] of Object.entries(autos)) {
    const template = byName.get(a.template) || null;
    list[key] = {
      ...a,
      template,
      stats: weekStats[key] || {},
      cost: pricing.estimate(1, a.marketing ? 'MARKETING' : 'UTILITY').each,
    };
  }
  const jobNames = ['orders', 'carts', 'stock', 'reorder', 'customers'];
  res.json({
    automations: list,
    optInFromShopify: { enabled: !!optin.enabled, subscribed, optedIn },
    sync: {
      orders: { lastRunAt: syncOrders.lastRunAt || null, lastError: syncOrders.lastError || null, running: isRunning('orders') },
      customers: {
        lastRunAt: syncCustomers.lastRunAt || null,
        lastError: syncCustomers.lastError || null,
        total: syncCustomers.total || null,
        importing: !!syncCustomers.cursor,
        running: isRunning('customers'),
      },
    },
    jobs: Object.fromEntries(jobNames.map((j, i) => [j, { ...jobs[i], running: isRunning(j) }])),
    shopifyConnected: shopify.isConfigured(),
    whatsappConnected: !!process.env.WHATSAPP_TOKEN && process.env.TEST_MODE !== 'true',
    testMode: process.env.TEST_MODE === 'true',
    metaReady: templates.metaReady(),
    ai: aiAnswer.status(),
    quietHours: process.env.QUIET_HOURS || '21-9',
  });
}));

router.patch('/:key', asyncHandler(async (req, res) => {
  res.json(await automations.update(req.params.key, req.body || {}));
}));

// "Check now": runs a job and waits up to ~20 seconds for it.
router.post('/run', asyncHandler(async (req, res) => {
  const job = String(req.body.job || '');
  const run = runJob(job);
  const timeout = new Promise((r) => setTimeout(() => r({ stillRunning: true }), 20000));
  res.json(await Promise.race([run, timeout]));
}));

router.put('/optin-shopify', asyncHandler(async (req, res) => {
  res.json(await customerSync.setOptInFromShopify(req.body.enabled === true));
}));

module.exports = router;
