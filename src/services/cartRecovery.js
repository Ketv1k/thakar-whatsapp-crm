// Abandoned-cart reminders: one WhatsApp message, a while after someone leaves
// checkout without paying, with the link back to their cart. Only for
// customers who opted in to offers, never at night, and never twice.
const AbandonedCheckout = require('../models/AbandonedCheckout');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const shopify = require('./shopify');
const settings = require('./settings');
const automations = require('./automations');
const templates = require('./templates');
const outbound = require('./outbound');
const consent = require('./consent');
const { normalizePhone } = require('../utils/phone');
const { isQuietTime } = require('../utils/time');

const HOUR = 60 * 60 * 1000;
// Reminders only for carts left in the last day; older ones are stale.
const MAX_AGE = 24 * HOUR;

function attribute(node, key) {
  const a = (node.customAttributes || []).find((x) => x.key === key);
  return a ? String(a.value == null ? '' : a.value) : null;
}

function numericId(gid) {
  const id = String(gid || '').split('/').pop();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * The best link back to this cart, for this store:
 *  - Razorpay Magic Checkout records its own recovery link
 *    (".../cart?magic_order_id=..."); opening it reopens the order in Magic
 *    Checkout. It's rewritten onto the shop's own domain.
 *  - Otherwise a cart link with the same products that opens the cart page
 *    (?storefront=true), where the usual Checkout button works - including
 *    Magic Checkout.
 *  - Otherwise Shopify's own checkout link.
 * Pure. Returns { url, linkType }.
 */
function recoveryLink(node, storeUrl) {
  const magic = attribute(node, 'magic_checkout_url');
  if (magic) {
    try {
      const orderId = new URL(magic).searchParams.get('magic_order_id');
      if (orderId && /^[\w-]{4,80}$/.test(orderId)) {
        return { url: `${storeUrl}/cart?magic_order_id=${encodeURIComponent(orderId)}`, linkType: 'magic' };
      }
    } catch (err) {
      /* not a URL: fall through */
    }
  }
  const items = (node.lineItems?.edges || []).map((e) => ({ id: numericId(e.node.variant?.id), qty: Number(e.node.quantity) || 1 }));
  if (items.length && items.every((i) => i.id)) {
    return { url: `${storeUrl}/cart/${items.map((i) => `${i.id}:${i.qty}`).join(',')}?storefront=true`, linkType: 'cart' };
  }
  return { url: node.abandonedCheckoutUrl || null, linkType: node.abandonedCheckoutUrl ? 'shopify' : null };
}

function mapCheckout(node, storeUrl = shopify.storeUrl()) {
  const items = (node.lineItems?.edges || []).map((e) => e.node.title).filter(Boolean);
  const consent = attribute(node, 'checkout_whatsapp_consent');
  const link = recoveryLink(node, storeUrl);
  return {
    shopifyId: node.id,
    phone:
      normalizePhone(node.customer?.phone) ||
      normalizePhone(node.shippingAddress?.phone) ||
      normalizePhone(node.billingAddress?.phone) ||
      normalizePhone(attribute(node, 'contact')),
    firstName: (node.customer?.firstName || node.shippingAddress?.firstName || '').trim(),
    url: link.url,
    linkType: link.linkType,
    shopifyUrl: node.abandonedCheckoutUrl || null,
    whatsappConsent: consent === 'true' ? true : consent === 'false' ? false : null,
    dropOffStep: attribute(node, 'drop_off_step') || null,
    total: Number(node.totalPriceSet?.shopMoney?.amount || 0),
    currency: node.totalPriceSet?.shopMoney?.currencyCode || 'INR',
    items,
    checkoutCreatedAt: node.createdAt ? new Date(node.createdAt) : null,
    completedAt: node.completedAt ? new Date(node.completedAt) : null,
  };
}

// "Kaju Curry", "Kaju Curry and Dal Tadka", "Kaju Curry and 2 more".
function itemsLabel(items) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return 'your favourites';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list[0]} and ${list.length - 1} more`;
}

/**
 * Pure: should this cart get its reminder now?
 * Returns { action: 'send' | 'wait' | 'skip', reason }.
 * ctx: { automation, optedIn, optedOut, orderedSince, recentReminder, now, ignoreQuietHours }
 */
function decide(checkout, ctx) {
  const now = ctx.now || new Date();
  const a = ctx.automation;
  if (!a || !a.enabled) return { action: 'wait', reason: 'Automation is off' };
  if (checkout.remindedAt || checkout.completedAt || checkout.recoveredAt) return { action: 'skip', reason: 'Already handled' };
  const created = checkout.checkoutCreatedAt ? new Date(checkout.checkoutCreatedAt) : null;
  if (!created) return { action: 'skip', reason: 'No date' };
  if (!checkout.simulated && !automations.activeFor(a, created)) {
    return { action: 'skip', reason: 'Left before reminders were switched on' };
  }
  const age = now.getTime() - created.getTime();
  if (age > MAX_AGE) return { action: 'skip', reason: 'Too old for a reminder' };
  const delay = (a.options.delayMinutes || 60) * 60 * 1000;
  if (age < delay) return { action: 'wait', reason: 'Not yet' };
  if (!checkout.phone) return { action: 'skip', reason: 'No phone number' };
  if (!checkout.url) return { action: 'skip', reason: 'No cart link' };
  if (ctx.orderedSince) return { action: 'skip', reason: 'They placed an order' };
  // Permission: the WhatsApp consent they gave at checkout, or a general
  // opt-in to offers. A "no" at checkout or a STOP always wins.
  if (ctx.optedOut) return { action: 'skip', reason: 'They replied STOP' };
  if (checkout.whatsappConsent === false) return { action: 'skip', reason: 'Said no to WhatsApp messages at checkout' };
  if (!ctx.optedIn && checkout.whatsappConsent !== true) return { action: 'skip', reason: 'Not opted in to offers' };
  if (ctx.recentReminder) return { action: 'skip', reason: 'Already reminded in the last day' };
  if (!ctx.ignoreQuietHours && isQuietTime(now)) return { action: 'wait', reason: 'Night time: waits until morning' };
  return { action: 'send', reason: '' };
}

// Pulls carts left in the last ~day from Shopify.
async function syncCheckouts() {
  if (!shopify.isConfigured()) return { skipped: 'Shopify not connected' };
  const since = new Date(Date.now() - 26 * HOUR).toISOString();
  let after = null;
  let fetched = 0;
  for (let page = 0; page < 10; page++) {
    const data = await shopify.graphql(
      `query Carts($q: String!, $after: String) {
        abandonedCheckouts(first: 50, after: $after, sortKey: CREATED_AT, query: $q) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id createdAt completedAt abandonedCheckoutUrl
            customer { firstName phone }
            shippingAddress { phone firstName }
            billingAddress { phone }
            customAttributes { key value }
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 20) { edges { node { title quantity variant { id } } } }
          } }
        }
      }`,
      { q: `created_at:>'${since}'`, after },
      { timeout: 30000 }
    );
    const conn = data.abandonedCheckouts;
    for (const edge of conn.edges) {
      const fields = mapCheckout(edge.node);
      await AbandonedCheckout.updateOne({ shopifyId: fields.shopifyId }, { $set: fields }, { upsert: true });
      // Ticking WhatsApp at checkout is permission for order updates there.
      if (fields.whatsappConsent === true && fields.phone) {
        await Customer.updateOne(
          { phone: fields.phone, orderUpdatesOptIn: { $ne: true }, noWhatsApp: { $ne: true } },
          { $set: { orderUpdatesOptIn: true, orderUpdatesEvidence: `Ticked the WhatsApp box at checkout on ${consent.stamp(fields.checkoutCreatedAt || new Date())}` }, $setOnInsert: { phone: fields.phone } },
          { upsert: true }
        ).catch((err) => { if (err.code !== 11000) throw err; });
      }
      fetched++;
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  await settings.merge('sync:carts', { lastRunAt: new Date(), lastFetched: fetched });
  return { fetched };
}

async function remind(checkout, automation, { now = new Date(), ignoreQuietHours = false } = {}) {
  const [customer, orderedSince, recentReminder] = await Promise.all([
    checkout.phone ? Customer.findOne({ phone: checkout.phone }).select('optedInMarketing optedOutAt name').lean() : null,
    checkout.phone ? Order.exists({ phone: checkout.phone, placedAt: { $gte: checkout.checkoutCreatedAt } }) : null,
    checkout.phone
      ? AbandonedCheckout.exists({ phone: checkout.phone, remindStatus: 'sent', remindedAt: { $gte: new Date(now.getTime() - 24 * HOUR) } })
      : null,
  ]);
  const decision = decide(checkout, {
    automation,
    optedIn: !!(customer && customer.optedInMarketing),
    optedOut: !!(customer && customer.optedOutAt && !customer.optedInMarketing),
    orderedSince: !!orderedSince,
    recentReminder: !!recentReminder,
    now,
    ignoreQuietHours,
  });
  if (decision.action === 'wait') return decision;
  if (decision.action === 'skip') {
    await AbandonedCheckout.updateOne(
      { _id: checkout._id, remindStatus: null },
      { $set: { remindStatus: 'skipped', skipReason: decision.reason } }
    );
    return decision;
  }
  const template = await templates.findByName('cart_reminder');
  if (!template || !templates.canSend(template)) return { action: 'wait', reason: 'Template not approved yet' };
  // Claim first, so two runs can never both send.
  const claimed = await AbandonedCheckout.findOneAndUpdate(
    { _id: checkout._id, remindedAt: null },
    { $set: { remindedAt: now, remindStatus: 'sending' } },
    { new: true }
  );
  if (!claimed) return { action: 'skip', reason: 'Already handled' };
  const first = claimed.firstName || String((customer && customer.name) || '').split(' ')[0] || 'there';
  const result = await outbound.sendTemplate({
    to: claimed.phone,
    template,
    bodyParams: [first, itemsLabel(claimed.items), claimed.url],
    kind: 'cart_reminder',
  });
  if (outbound.shouldRetry(result, claimed.sendAttempts)) {
    await AbandonedCheckout.updateOne(
      { _id: claimed._id },
      { $set: { remindedAt: null, remindStatus: null, skipReason: `Will try again: ${result.error}` }, $inc: { sendAttempts: 1 } }
    );
    return { action: 'retrying', reason: result.error };
  }
  await AbandonedCheckout.updateOne(
    { _id: claimed._id },
    { $set: { remindStatus: result.ok ? 'sent' : 'failed', skipReason: result.ok ? null : result.error } }
  );
  if (result.ok) await Customer.updateOne({ phone: claimed.phone }, { $set: { lastMarketingAt: now } });
  return { action: result.ok ? 'sent' : 'failed', reason: result.error || '' };
}

async function sendDueReminders({ now = new Date() } = {}) {
  const automation = await automations.get('abandoned_cart');
  if (!automation.enabled) return { skipped: 'off' };
  const due = await AbandonedCheckout.find({
    remindedAt: null,
    remindStatus: null,
    completedAt: null,
    checkoutCreatedAt: { $gte: new Date(now.getTime() - MAX_AGE), $lte: new Date(now.getTime() - automation.options.delayMinutes * 60 * 1000) },
  }).limit(200);
  const tally = {};
  for (const checkout of due) {
    const r = await remind(checkout, automation, { now });
    tally[r.action] = (tally[r.action] || 0) + 1;
  }
  return tally;
}

async function run() {
  const automation = await automations.get('abandoned_cart');
  if (!automation.enabled) return { skipped: 'off' };
  const synced = await syncCheckouts();
  const sent = await sendDueReminders();
  return { ...synced, ...sent };
}

module.exports = { mapCheckout, recoveryLink, itemsLabel, decide, syncCheckouts, sendDueReminders, remind, run, MAX_AGE };
