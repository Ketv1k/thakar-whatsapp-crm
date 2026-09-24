// Keeps a copy of recent Shopify orders and sends the WhatsApp updates the
// founder switched on: order confirmed, COD confirmation, shipped, out for
// delivery, delivered.
//
// Runs every few minutes (jobs/scheduler.js) and asks Shopify only for orders
// changed since the last run, so it also catches up after the server slept.
// Every update is claimed in the database before it's sent, so it can never
// go out twice.
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const AbandonedCheckout = require('../models/AbandonedCheckout');
const shopify = require('./shopify');
const cartLinks = require('./cartLinks');
const settings = require('./settings');
const automations = require('./automations');
const templates = require('./templates');
const outbound = require('./outbound');
const { dueEvents } = require('./orderEvents');
const consent = require('./consent');
const { normalizePhone } = require('../utils/phone');
const { formatMoney } = require('../utils/money');

const DAY = 24 * 60 * 60 * 1000;
// First run imports this much history, for reorder reminders and context.
const BACKFILL_DAYS = 45;
const PAGE_SIZE = 40;
const MAX_PAGES_PER_RUN = 40;

const ORDER_FIELDS = `
  id name createdAt updatedAt cancelledAt test
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames tags statusPageUrl
  customAttributes { key value }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalOutstandingSet { shopMoney { amount } }
  phone
  customer { id firstName displayName phone }
  shippingAddress { phone firstName city }
  billingAddress { phone }
  lineItems(first: 5) { edges { node { title quantity product { id handle onlineStoreUrl } } } }
  fulfillments(first: 5) { id createdAt updatedAt status displayStatus deliveredAt trackingInfo(first: 1) { company number url } }
`;

const COD_GATEWAY = /cash[\s_-]*on[\s_-]*delivery|(^|[^a-z])cod([^a-z]|$)/i;

// Shopify order -> our Order fields. Pure.
function mapOrder(node) {
  const money = (set) => Number(set?.shopMoney?.amount || 0);
  const phone =
    normalizePhone(node.phone) ||
    normalizePhone(node.customer?.phone) ||
    normalizePhone(node.shippingAddress?.phone) ||
    normalizePhone(node.billingAddress?.phone);
  const firstName = (node.customer?.firstName || node.shippingAddress?.firstName || '').trim();
  const gateways = node.paymentGatewayNames || [];
  const tags = node.tags || [];
  const fulfillments = (node.fulfillments || [])
    .filter((f) => !['CANCELLED', 'ERROR', 'FAILURE'].includes(f.status) && f.displayStatus !== 'CANCELED')
    .map((f) => ({
      id: f.id,
      createdAt: f.createdAt ? new Date(f.createdAt) : null,
      updatedAt: f.updatedAt ? new Date(f.updatedAt) : null,
      displayStatus: f.displayStatus || null,
      deliveredAt: f.deliveredAt ? new Date(f.deliveredAt) : f.displayStatus === 'DELIVERED' && f.updatedAt ? new Date(f.updatedAt) : null,
      trackingUrl: f.trackingInfo?.[0]?.url || null,
      trackingNumber: f.trackingInfo?.[0]?.number || null,
      trackingCompany: f.trackingInfo?.[0]?.company || null,
    }));
  const earliest = (dates) => {
    const ts = dates.filter(Boolean).map((d) => d.getTime());
    return ts.length ? new Date(Math.min(...ts)) : null;
  };
  const ofd = fulfillments.filter((f) => f.displayStatus === 'OUT_FOR_DELIVERY');
  const storeUrl = shopify.storeUrl();
  return {
    shopifyId: node.id,
    name: node.name || '',
    phone,
    firstName,
    customerName: node.customer?.displayName || firstName || '',
    shopifyCustomerId: node.customer?.id || null,
    placedAt: node.createdAt ? new Date(node.createdAt) : null,
    shopifyUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
    cancelledAt: node.cancelledAt ? new Date(node.cancelledAt) : null,
    shopifyTest: !!node.test,
    total: money(node.currentTotalPriceSet),
    outstanding: money(node.totalOutstandingSet),
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode || 'INR',
    financialStatus: node.displayFinancialStatus || null,
    fulfillmentStatus: node.displayFulfillmentStatus || null,
    gateways,
    tags,
    isCod: gateways.some((g) => COD_GATEWAY.test(g)) || tags.some((t) => COD_GATEWAY.test(t)),
    statusPageUrl: node.statusPageUrl || null,
    waCartId: cartLinks.cartIdOf(node.customAttributes),
    items: (node.lineItems?.edges || []).map((e) => ({
      title: e.node.title,
      quantity: e.node.quantity,
      productId: e.node.product?.id || null,
      handle: e.node.product?.handle || null,
      url: e.node.product?.onlineStoreUrl || (e.node.product?.handle ? `${storeUrl}/products/${e.node.product.handle}` : null),
    })),
    fulfillments,
    shippedAt: earliest(fulfillments.map((f) => f.createdAt)),
    outForDeliveryAt: ofd.length ? earliest(ofd.map((f) => f.updatedAt)) : null,
    deliveredAt: earliest(fulfillments.map((f) => f.deliveredAt)),
  };
}

// Saves an order; returns { order, isNew }.
async function upsertOrder(fields) {
  const res = await Order.findOneAndUpdate(
    { shopifyId: fields.shopifyId },
    { $set: fields },
    { upsert: true, new: true, includeResultMetadata: true }
  );
  const isNew = !res.lastErrorObject?.updatedExisting;
  const order = res.value;
  if (order.phone) {
    // Keep the customer record current between customer syncs.
    await Customer.updateOne(
      { phone: order.phone },
      {
        $setOnInsert: { phone: order.phone, name: order.customerName || '' },
        ...(order.placedAt && !order.cancelledAt ? { $max: { lastOrderAt: order.placedAt } } : {}),
      },
      { upsert: true }
    );
    if (isNew && order.placedAt) await markCartRecovered(order);
  }
  return { order, isNew };
}

// A new order from someone who got a cart reminder in the 3 days before.
async function markCartRecovered(order) {
  await AbandonedCheckout.updateMany(
    {
      phone: order.phone,
      remindStatus: 'sent',
      recoveredAt: null,
      remindedAt: { $gte: new Date(order.placedAt.getTime() - 3 * DAY), $lte: order.placedAt },
    },
    { $set: { recoveredAt: order.placedAt, recoveredOrderName: order.name, recoveredTotal: order.total } }
  );
}

function firstNameOf(order) {
  return (order.firstName || String(order.customerName || '').split(' ')[0] || '').trim() || 'there';
}

// Template variables for each update.
function paramsFor(event, order) {
  const first = firstNameOf(order);
  switch (event) {
    case 'confirmed':
      return [first, order.name, formatMoney(order.total, order.currency)];
    case 'cod_request':
      return [first, order.name, formatMoney(order.outstanding > 0 ? order.outstanding : order.total, order.currency)];
    case 'shipped': {
      const tracked = (order.fulfillments || []).find((f) => f.trackingUrl);
      return [first, order.name, (tracked && tracked.trackingUrl) || order.statusPageUrl || shopify.storeUrl()];
    }
    default:
      return [first, order.name];
  }
}

const TEMPLATE_FOR = {
  confirmed: 'order_confirmed',
  cod_request: 'cod_confirmation',
  shipped: 'order_shipped',
  out_for_delivery: 'order_out_for_delivery',
  delivered: 'order_delivered',
};

const KIND_FOR = {
  confirmed: 'order_confirmed',
  cod_request: 'cod_request',
  shipped: 'order_shipped',
  out_for_delivery: 'out_for_delivery',
  delivered: 'order_delivered',
};

async function note(order, event, text) {
  await Order.updateOne({ _id: order._id }, { $set: { [`notifyNotes.${event}`]: text } });
}

// Sends one update, once. Returns 'sent' | 'failed' | 'waiting' | 'taken'.
async function sendOrderEvent(order, event) {
  const template = await templates.findByName(TEMPLATE_FOR[event]);
  if (!template || !templates.canSend(template)) {
    // Not claimed: it goes out on a later run once Meta approves the template
    // (while the update is still recent enough to be useful).
    await note(order, event, 'Waiting: the WhatsApp template is not approved yet');
    return 'waiting';
  }
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, [`notified.${event}`]: null },
    { $set: { [`notified.${event}`]: new Date() } },
    { new: true }
  );
  if (!claimed) return 'taken';

  const result = await outbound.sendTemplate({
    to: claimed.phone,
    template,
    bodyParams: paramsFor(event, claimed),
    kind: KIND_FOR[event],
    quickReplyPayloads:
      event === 'cod_request'
        ? { 'Confirm order': `COD_CONFIRM:${claimed._id}`, 'Cancel order': `COD_CANCEL:${claimed._id}` }
        : {},
  });
  const tries = (claimed.sendAttempts && claimed.sendAttempts[event]) || 0;
  if (outbound.shouldRetry(result, tries)) {
    // A temporary problem: release the claim so the next run tries again.
    await Order.updateOne(
      { _id: claimed._id },
      { $set: { [`notified.${event}`]: null, [`notifyNotes.${event}`]: `Will try again: ${result.error}` }, $inc: { [`sendAttempts.${event}`]: 1 } }
    );
    return 'retrying';
  }
  const update = { [`notifyNotes.${event}`]: result.ok ? 'Sent' : `Failed: ${result.error}` };
  if (event === 'cod_request' && result.ok) {
    update['cod.status'] = 'awaiting';
    update['cod.requestedAt'] = new Date();
  }
  await Order.updateOne({ _id: claimed._id }, { $set: update });
  return result.ok ? 'sent' : 'failed';
}

// Works out and sends whatever this order needs now.
async function processOrder(order, autos, now = new Date()) {
  const due = dueEvents(order, autos, now);
  let send = due.send;
  const skip = [...due.skip];
  const results = {};
  // Not to customers who replied STOP ALL (services/consent.js).
  if (send.length) {
    const permission = await consent.canSendOrderUpdates(order.phone);
    if (!permission.allowed) {
      for (const event of send) {
        skip.push({ event, reason: permission.reason });
        results[event] = 'stopped';
      }
      send = [];
    }
  }
  for (const s of skip) {
    await Order.updateOne(
      { _id: order._id, [`notified.${s.event}`]: null },
      { $set: { [`notified.${s.event}`]: now, [`notifyNotes.${s.event}`]: s.reason } }
    );
  }
  for (const event of send) results[event] = await sendOrderEvent(order, event);
  return results;
}

// Recent orders get another look every run, so an update waiting on template
// approval (or an automation switched on a minute after the order) still goes.
async function processRecentOrders(now = new Date()) {
  const autos = await automations.getAll();
  if (!Object.values(autos).some((a) => a.enabled && !a.marketing)) return { checked: 0 };
  const since = new Date(now.getTime() - 2 * DAY);
  const orders = await Order.find({
    cancelledAt: null,
    phone: { $ne: null },
    $or: [{ placedAt: { $gte: since } }, { shippedAt: { $gte: since } }, { deliveredAt: { $gte: since } }, { outForDeliveryAt: { $gte: since } }],
  }).limit(1000);
  const tally = {};
  for (const order of orders) {
    const results = await processOrder(order, autos, now);
    for (const r of Object.values(results)) tally[r] = (tally[r] || 0) + 1;
  }
  return { checked: orders.length, ...tally };
}

// One order, fresh from Shopify (for instant updates): saved, then any
// update that's due goes out now.
async function syncOne(gid) {
  const data = await shopify.graphql(`query One($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid });
  if (!data.order) return null;
  const { order } = await upsertOrder(mapOrder(data.order));
  if (order.phone) await processOrder(order, await automations.getAll());
  return order;
}

// Pulls changed orders from Shopify (checkpointed), then processes recent ones.
async function syncOrders() {
  if (!shopify.isConfigured()) return { skipped: 'Shopify not connected' };
  const state = await settings.get('sync:orders', {});
  let checkpoint = state.checkpoint ? new Date(state.checkpoint) : new Date(Date.now() - BACKFILL_DAYS * DAY);
  // Small overlap so an order updated during the last run isn't missed.
  const since = new Date(checkpoint.getTime() - 2 * 60 * 1000);
  let after = null;
  let fetched = 0;
  let created = 0;
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await shopify.graphql(
        `query Orders($q: String!, $after: String) {
          orders(first: ${PAGE_SIZE}, after: $after, sortKey: UPDATED_AT, query: $q) {
            pageInfo { hasNextPage endCursor }
            edges { node { ${ORDER_FIELDS} } }
          }
        }`,
        { q: `updated_at:>'${since.toISOString()}'`, after },
        { timeout: 30000 }
      );
      const conn = data.orders;
      for (const edge of conn.edges) {
        const { isNew } = await upsertOrder(mapOrder(edge.node));
        fetched++;
        if (isNew) created++;
        const updatedAt = new Date(edge.node.updatedAt);
        if (updatedAt > checkpoint) checkpoint = updatedAt;
      }
      // Save progress after every page, so a long first import resumes.
      await settings.merge('sync:orders', { checkpoint });
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    const processed = await processRecentOrders();
    await settings.merge('sync:orders', { lastRunAt: new Date(), lastError: null, lastFetched: fetched });
    return { fetched, created, ...processed };
  } catch (err) {
    await settings.merge('sync:orders', { lastRunAt: new Date(), lastError: err.message.slice(0, 300) });
    throw err;
  }
}

module.exports = {
  mapOrder,
  upsertOrder,
  syncOrders,
  syncOne,
  processOrder,
  processRecentOrders,
  sendOrderEvent,
  paramsFor,
  firstNameOf,
  COD_GATEWAY,
};
