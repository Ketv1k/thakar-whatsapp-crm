// Reorder reminders: a nudge some days after an order shipped ("Running low
// on Kaju Curry?"), for customers who opted in to offers and haven't ordered
// again since. At most one every 30 days per customer, and only in the daytime.
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const automations = require('./automations');
const templates = require('./templates');
const outbound = require('./outbound');
const shopify = require('./shopify');
const { firstNameOf } = require('./orderSync');
const { isQuietTime } = require('../utils/time');

const DAY = 24 * 60 * 60 * 1000;
// Orders are eligible for a week after they reach the chosen age.
const WINDOW_DAYS = 7;
const MIN_GAP_DAYS = 30;

function baseDate(order) {
  return order.deliveredAt || order.shippedAt || order.placedAt || null;
}

/**
 * Pure: should this order's customer get a reorder reminder now?
 * ctx: { automation, optedIn, newerOrder, recentReminder, now, ignoreQuietHours }
 */
function decide(order, ctx) {
  const now = ctx.now || new Date();
  const a = ctx.automation;
  if (!a || !a.enabled) return { action: 'wait', reason: 'Automation is off' };
  if (!order.phone || order.cancelledAt) return { action: 'skip', reason: 'No phone or cancelled' };
  if (order.notified && order.notified.reorder) return { action: 'skip', reason: 'Already reminded' };
  const base = baseDate(order);
  if (!base) return { action: 'skip', reason: 'No date' };
  const ageDays = (now.getTime() - new Date(base).getTime()) / DAY;
  const days = a.options.days || 21;
  if (ageDays < days) return { action: 'wait', reason: 'Not yet' };
  if (ageDays > days + WINDOW_DAYS) return { action: 'skip', reason: 'Too long ago' };
  if (ctx.newerOrder) return { action: 'skip', reason: 'They ordered again' };
  if (!ctx.optedIn) return { action: 'skip', reason: 'Not opted in to offers' };
  if (ctx.recentReminder) return { action: 'skip', reason: 'Reminded in the last 30 days' };
  if (!ctx.ignoreQuietHours && isQuietTime(now)) return { action: 'wait', reason: 'Night time: waits until morning' };
  return { action: 'send', reason: '' };
}

function productLabel(order) {
  const items = (order.items || []).map((i) => i.title).filter(Boolean);
  if (items.length === 0) return 'order';
  return items.length === 1 ? items[0] : `${items[0]} and more`;
}

async function remind(order, automation, { now = new Date(), ignoreQuietHours = false } = {}) {
  const [customer, newerOrder, recentReminder] = await Promise.all([
    Customer.findOne({ phone: order.phone }).select('optedInMarketing').lean(),
    Order.exists({ phone: order.phone, placedAt: { $gt: order.placedAt }, cancelledAt: null, _id: { $ne: order._id } }),
    Order.exists({ phone: order.phone, 'notified.reorder': { $gte: new Date(now.getTime() - MIN_GAP_DAYS * DAY) }, 'notifyNotes.reorder': 'Sent' }),
  ]);
  const decision = decide(order, {
    automation,
    optedIn: !!(customer && customer.optedInMarketing),
    newerOrder: !!newerOrder,
    recentReminder: !!recentReminder,
    now,
    ignoreQuietHours,
  });
  if (decision.action === 'wait') return decision;
  if (decision.action === 'skip') {
    await Order.updateOne({ _id: order._id, 'notified.reorder': null }, { $set: { 'notified.reorder': now, 'notifyNotes.reorder': decision.reason } });
    return decision;
  }
  const template = await templates.findByName('reorder_reminder');
  if (!template || !templates.canSend(template)) return { action: 'wait', reason: 'Template not approved yet' };
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, 'notified.reorder': null },
    { $set: { 'notified.reorder': now, 'notifyNotes.reorder': 'Sending' } },
    { new: true }
  );
  if (!claimed) return { action: 'skip', reason: 'Already handled' };
  const url = (claimed.items || []).find((i) => i.url)?.url || shopify.storeUrl();
  const result = await outbound.sendTemplate({
    to: claimed.phone,
    template,
    bodyParams: [firstNameOf(claimed), productLabel(claimed), url],
    kind: 'reorder_reminder',
  });
  const tries = (claimed.sendAttempts && claimed.sendAttempts.reorder) || 0;
  if (outbound.shouldRetry(result, tries)) {
    await Order.updateOne(
      { _id: claimed._id },
      { $set: { 'notified.reorder': null, 'notifyNotes.reorder': `Will try again: ${result.error}` }, $inc: { 'sendAttempts.reorder': 1 } }
    );
    return { action: 'retrying', reason: result.error };
  }
  await Order.updateOne({ _id: claimed._id }, { $set: { 'notifyNotes.reorder': result.ok ? 'Sent' : `Failed: ${result.error}` } });
  if (result.ok) await Customer.updateOne({ phone: claimed.phone }, { $set: { lastMarketingAt: now } });
  return { action: result.ok ? 'sent' : 'failed', reason: result.error || '' };
}

async function run({ now = new Date() } = {}) {
  const automation = await automations.get('reorder_reminder');
  if (!automation.enabled) return { skipped: 'off' };
  if (isQuietTime(now)) return { skipped: 'night' };
  const days = automation.options.days || 21;
  const from = new Date(now.getTime() - (days + WINDOW_DAYS) * DAY);
  const to = new Date(now.getTime() - days * DAY);
  const orders = await Order.find({
    'notified.reorder': null,
    cancelledAt: null,
    phone: { $ne: null },
    $or: [{ deliveredAt: { $gte: from, $lte: to } }, { deliveredAt: null, shippedAt: { $gte: from, $lte: to } }],
  })
    .sort({ placedAt: 1 })
    .limit(300);
  const tally = {};
  for (const order of orders) {
    const r = await remind(order, automation, { now });
    tally[r.action] = (tally[r.action] || 0) + 1;
  }
  return { checked: orders.length, ...tally };
}

module.exports = { decide, remind, run, productLabel, baseDate };
