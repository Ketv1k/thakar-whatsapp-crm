// Carts built in the chat: the founder picks products, the customer gets a
// link that opens the shop's cart page with exactly those items, where the
// Checkout button (Razorpay Magic Checkout) takes them through address and
// payment. The link carries the cart's id in its UTM tags: Magic Checkout
// saves a landing page's UTM tags on the cart (rzp_3p_utm) and copies them
// onto the order, so the order can be matched back to the chat.
const crypto = require('crypto');
const { formatMoney } = require('../utils/money');

const MAX_LINES = 20;
const MAX_QTY = 50;
const MATCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function numericId(gid) {
  const id = String(gid || '').split('/').pop();
  return /^\d{1,20}$/.test(id) ? id : null;
}

// [{ variantId, quantity }] -> cleaned, merged list, or an error string.
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Add at least one product' };
  const byId = new Map();
  for (const raw of items) {
    const id = numericId(raw && raw.variantId);
    if (!id) return { error: 'Unknown product' };
    const qty = Math.round(Number(raw.quantity));
    if (!Number.isFinite(qty) || qty < 1) return { error: 'Quantities must be 1 or more' };
    byId.set(id, Math.min(MAX_QTY, (byId.get(id) || 0) + qty));
  }
  if (byId.size > MAX_LINES) return { error: `At most ${MAX_LINES} different products in one cart` };
  return { items: [...byId].map(([id, quantity]) => ({ variantId: `gid://shopify/ProductVariant/${id}`, numericId: id, quantity })) };
}

function newCartId() {
  return crypto.randomBytes(5).toString('hex');
}

const CART_ID_RE = /^[a-f0-9]{10}$/;
const UTM = { utm_source: 'whatsapp', utm_medium: 'chat', utm_campaign: 'cart_link' };

// Opens the cart page (not Shopify's own checkout) with these items.
// Shopify keeps the UTM tags when it redirects to /cart. They also show
// sales from these links as "whatsapp / chat" in Razorpay's reports.
function buildCartUrl(storeUrl, items, cartId) {
  const lines = items.map((i) => `${i.numericId}:${i.quantity}`).join(',');
  const query = new URLSearchParams({ storefront: 'true', ...UTM, utm_content: cartId });
  return `${storeUrl}/cart/${lines}?${query}`;
}

// The chat cart an order came from, read from the order's attributes:
// utm_* keys, or Magic Checkout's own "utm_source:whatsapp||utm_medium:..."
// string when they weren't split out.
function cartIdOf(attributes) {
  const attr = new Map((attributes || []).map((a) => [a.key, String(a.value || '')]));
  for (const part of (attr.get('rzp_3p_utm') || '').split('||')) {
    const at = part.indexOf(':');
    if (at > 0 && !attr.has(part.slice(0, at))) attr.set(part.slice(0, at), part.slice(at + 1));
  }
  if (!Object.entries(UTM).every(([k, v]) => attr.get(k) === v)) return null;
  const id = attr.get('utm_content');
  return CART_ID_RE.test(id || '') ? id : null;
}

// Which order came from each cart link (cart messages oldest first). An
// order carrying the cart's id is a sure match. Otherwise the customer's
// first untagged order after the link counts, if it came within 3 days and
// before the next cart link.
function matchOrders(carts, orders) {
  const time = (d) => new Date(d).getTime();
  const sorted = [...orders].sort((a, b) => time(a.placedAt) - time(b.placedAt));
  return carts.map((m, i) => {
    const exact = sorted.find((o) => o.waCartId === m.cart.id);
    if (exact) return { order: exact, exact: true };
    const from = time(m.createdAt);
    const next = i + 1 < carts.length ? time(carts[i + 1].createdAt) : Infinity;
    const until = Math.min(next, from + MATCH_WINDOW_MS);
    const soon = sorted.find((o) => !o.waCartId && time(o.placedAt) >= from && time(o.placedAt) < until);
    return soon ? { order: soon, exact: false } : null;
  });
}

// The WhatsApp message the customer receives.
function cartMessage(lines, url, currency = 'INR') {
  const rows = lines.map((l) => {
    const name = l.variantTitle ? `${l.productTitle} (${l.variantTitle})` : l.productTitle;
    return `• ${name} × ${l.quantity} — ${formatMoney(l.price * l.quantity, currency)}`;
  });
  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  return {
    total,
    text:
      `Here's your cart from Thakar Kitchen:\n${rows.join('\n')}\n` +
      `Items total: ${formatMoney(total, currency)} (delivery charges, if any, show at checkout)\n\n` +
      `Tap to add your address and complete your order:\n${url}`,
  };
}

module.exports = { normalizeItems, buildCartUrl, cartIdOf, matchOrders, cartMessage, newCartId, numericId, MAX_LINES, MAX_QTY };
