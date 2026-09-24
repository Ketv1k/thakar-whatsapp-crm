// Customer numbers worked out from their orders: what they buy, how they pay
// and how often they order. The order sync only keeps recent orders, so the
// full history is imported once (orders only - old orders never trigger a
// message: they have no shipping updates and are older than the automations
// look at, and nothing already stored is changed).
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const shopify = require('./shopify');
const settings = require('./settings');
const { mapOrder } = require('./orderSync');

const DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_RUN = 80;

const HISTORY_FIELDS = `
  id name createdAt updatedAt cancelledAt test
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames tags statusPageUrl
  customAttributes { key value }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalOutstandingSet { shopMoney { amount } }
  phone
  customer { id firstName displayName phone }
  shippingAddress { phone firstName city }
  billingAddress { phone }
  lineItems(first: 10) { edges { node { title quantity product { id handle onlineStoreUrl } } } }
`;

// Imports orders older than the first run (resumable). Only adds orders the
// app doesn't have yet.
async function importHistory() {
  if (!shopify.isConfigured()) return { skipped: 'Shopify not connected' };
  const state = await settings.get('sync:history', {});
  if (state.done) return { history: 'done' };
  // Fixed at the first run, so paging stays stable; the regular order sync
  // covers everything newer.
  const before = state.before ? new Date(state.before) : new Date(Date.now() - 3 * DAY);
  let after = state.cursor || null;
  let added = 0;
  let pages = 0;
  for (; pages < MAX_PAGES_PER_RUN; pages++) {
    const data = await shopify.graphql(
      `query History($q: String!, $after: String) {
        orders(first: ${PAGE_SIZE}, after: $after, sortKey: CREATED_AT, query: $q) {
          pageInfo { hasNextPage endCursor }
          edges { node { ${HISTORY_FIELDS} } }
        }
      }`,
      { q: `created_at:<'${before.toISOString()}'`, after },
      { timeout: 30000 }
    );
    for (const edge of data.orders.edges) {
      const res = await Order.updateOne({ shopifyId: edge.node.id }, { $setOnInsert: mapOrder(edge.node) }, { upsert: true });
      if (res.upsertedCount) added++;
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    await settings.merge('sync:history', {
      before,
      cursor: after,
      done: !after,
      imported: (state.imported || 0) + added,
    });
    if (!after) break;
  }
  return { historyAdded: added, historyDone: !after };
}

// Pure: orders (each with the customer's phone) -> numbers per phone.
function summarize(orders) {
  const byPhone = new Map();
  for (const o of orders) {
    if (!o.phone) continue;
    if (!byPhone.has(o.phone)) byPhone.set(o.phone, []);
    byPhone.get(o.phone).push(o);
  }
  const out = new Map();
  for (const [phone, list] of byPhone) {
    const live = list.filter((o) => !o.cancelledAt && o.placedAt);
    const dates = live.map((o) => new Date(o.placedAt).getTime()).sort((a, b) => a - b);
    const qty = new Map();
    for (const o of live) {
      for (const item of o.items || []) {
        if (!item.title) continue;
        qty.set(item.title, (qty.get(item.title) || 0) + (Number(item.quantity) || 1));
      }
    }
    out.set(phone, {
      products: [...qty.keys()].sort((a, b) => a.localeCompare(b)),
      favourites: [...qty].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t),
      firstOrderAt: dates.length ? new Date(dates[0]) : null,
      avgGapDays: dates.length >= 2 ? Math.max(1, Math.round((dates[dates.length - 1] - dates[0]) / (dates.length - 1) / DAY)) : null,
      codOrders: live.filter((o) => o.isCod).length,
      prepaidOrders: live.filter((o) => !o.isCod).length,
      codCancelled: list.filter((o) => o.isCod && o.cancelledAt).length,
    });
  }
  return out;
}

// Recomputes every customer's numbers from the stored orders.
async function recompute() {
  const [orders, linked] = await Promise.all([
    Order.find({ simulated: { $ne: true }, shopifyTest: { $ne: true } })
      .select('phone shopifyCustomerId placedAt cancelledAt isCod items.title items.quantity')
      .lean(),
    Customer.find({ shopifyCustomerId: { $ne: null } }).select('phone shopifyCustomerId').lean(),
  ]);
  // An order belongs to the Shopify customer who placed it, whatever number
  // was typed on it; guest orders go by their phone.
  const phoneOfCustomer = new Map(linked.map((c) => [c.shopifyCustomerId, c.phone]));
  for (const o of orders) o.phone = phoneOfCustomer.get(o.shopifyCustomerId) || o.phone;
  const numbers = summarize(orders);
  const ops = [...numbers].map(([phone, fields]) => ({ updateOne: { filter: { phone }, update: { $set: fields } } }));
  for (let i = 0; i < ops.length; i += 500) await Customer.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  return { customersUpdated: ops.length, orders: orders.length };
}

async function run() {
  const history = await importHistory();
  const numbers = await recompute();
  return { ...history, ...numbers };
}

// Every product customers have bought, most popular first - for filters.
async function productList() {
  const rows = await Customer.aggregate([
    { $match: { products: { $exists: true, $ne: [] } } },
    { $unwind: '$products' },
    { $group: { _id: '$products', customers: { $sum: 1 } } },
    { $sort: { customers: -1, _id: 1 } },
    { $limit: 300 },
  ]);
  return rows.map((r) => ({ title: r._id, customers: r.customers }));
}

module.exports = { importHistory, summarize, recompute, run, productList };
