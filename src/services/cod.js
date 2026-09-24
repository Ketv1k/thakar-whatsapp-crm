// Cash-on-delivery confirmation. COD orders (including Razorpay "partial COD",
// where ₹99 is paid online and the rest on delivery) get a WhatsApp message
// with "Confirm order" / "Cancel order" buttons. The customer's tap comes back
// through the webhook and lands here.
const Order = require('../models/Order');
const shopify = require('./shopify');
const outbound = require('./outbound');
const whatsapp = require('./whatsapp');
const { firstNameOf } = require('./orderSync');

const PAYLOAD = /^COD_(CONFIRM|CANCEL):([a-f0-9]{24})$/;

const SHOPIFY_TAG = {
  confirmed: 'COD confirmed on WhatsApp',
  cancel_requested: 'COD cancel requested on WhatsApp',
};

// Shows the answer on the order in the Shopify admin, replacing an earlier
// answer's tag so the two never contradict. Never in test mode, and never
// for a test order that only exists in this app.
async function tagInShopify(order, status, previous = null) {
  const old = previous && previous !== status ? SHOPIFY_TAG[previous] : null;
  if (whatsapp.testMode() || order.simulated || !shopify.isConfigured()) {
    console.log(`[cod] (not tagging in Shopify) ${order.name}: ${SHOPIFY_TAG[status] || '-'}${old ? ` (removing "${old}")` : ''}`);
    return;
  }
  try {
    if (old) await shopify.removeOrderTags(order.shopifyId, [old]);
    if (SHOPIFY_TAG[status]) await shopify.addOrderTags(order.shopifyId, [SHOPIFY_TAG[status]]);
  } catch (err) {
    console.error(`[cod] could not tag ${order.name} in Shopify:`, err.message);
  }
}

function replyText(order, status) {
  const first = firstNameOf(order);
  if (order.cancelledAt) return `Hi ${first}, order ${order.name} has already been cancelled. Reply here if you need anything else.`;
  if (status === 'shipped') return `Hi ${first}, order ${order.name} has already been shipped, so it can't be changed here. Reply here and we'll help.`;
  if (status === 'confirmed') {
    return `Thank you, ${first}! Your order ${order.name} is confirmed. We'll send you the tracking link here once it ships.`;
  }
  return `Okay ${first}, we've noted that you'd like to cancel order ${order.name}. Our team will confirm the cancellation with you shortly.`;
}

/**
 * A button tap from the webhook. Returns null when it isn't a COD answer,
 * otherwise { status, order } after replying to the customer.
 */
async function handleButton({ payload, fromPhone, conversation }) {
  const m = PAYLOAD.exec(String(payload || ''));
  if (!m) return null;
  const order = await Order.findById(m[2]);
  if (!order || order.phone !== fromPhone) return null;
  const status = m[1] === 'CONFIRM' ? 'confirmed' : 'cancel_requested';
  const previous = order.cod.status;
  // Answers can change until the order ships (the latest one counts).
  const locked = !!(order.cancelledAt || order.shippedAt);
  const changedMind = !locked && ['confirmed', 'cancel_requested'].includes(previous) && previous !== status;

  if (!locked && previous !== status) {
    order.cod.status = status;
    order.cod.answeredAt = new Date();
    order.cod.answeredBy = 'customer';
    await order.save();
    await tagInShopify(order, status, previous);
    if (changedMind && status === 'confirmed') {
      // They asked to cancel, then confirmed: make sure no one cancels it.
      await require('./pushNotify')
        .send({ title: `${order.customerName || 'Customer'} now confirms ${order.name}`, body: 'They asked to cancel earlier. Don\'t cancel it.', url: '/#/orders', tag: `cod-${order.name}` })
        .catch(() => {});
    }
  }
  await outbound.sendText({
    conversationId: conversation._id,
    to: fromPhone,
    body: replyText(order, order.cancelledAt ? 'cancelled' : order.shippedAt ? 'shipped' : status),
    autoAck: 'cod_reply',
  });
  return { status, order, changedMind };
}

// The founder marks the answer themselves (e.g. after a phone call).
async function markByFounder(orderId, status) {
  if (!['confirmed', 'cancel_requested', 'awaiting'].includes(status)) {
    throw Object.assign(new Error('Unknown status'), { status: 400, expose: true });
  }
  const order = await Order.findById(orderId);
  if (!order) return null;
  const previous = order.cod.status;
  order.cod.status = status;
  order.cod.answeredAt = status === 'awaiting' ? null : new Date();
  order.cod.answeredBy = status === 'awaiting' ? null : 'founder';
  await order.save();
  await tagInShopify(order, status, previous);
  return order;
}

// Open COD orders still waiting on the customer.
function awaitingQuery() {
  return { isCod: true, 'cod.status': 'awaiting', cancelledAt: null, shippedAt: null };
}

module.exports = { handleButton, markByFounder, awaitingQuery, replyText, PAYLOAD, SHOPIFY_TAG };
