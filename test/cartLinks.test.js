const test = require('node:test');
const assert = require('node:assert');
const cartLinks = require('../src/services/cartLinks');
const { mapOrder } = require('../src/services/orderSync');

const V1 = 'gid://shopify/ProductVariant/48300507562239';
const V2 = 'gid://shopify/ProductVariant/48300507595007';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SENT = new Date('2026-09-23T08:00:00Z');
const at = (ms) => new Date(SENT.getTime() + ms);
const cartMsg = (id, sentAt) => ({ createdAt: sentAt, cart: { id } });
const utm = (id, extra = {}) =>
  Object.entries({ utm_source: 'whatsapp', utm_medium: 'chat', utm_campaign: 'cart_link', utm_content: id, ...extra }).map(([key, value]) => ({ key, value }));

test('cart items: merged, capped and checked', () => {
  const ok = cartLinks.normalizeItems([
    { variantId: V1, quantity: 2 },
    { variantId: V2, quantity: '1' },
    { variantId: V1, quantity: 1 },
  ]);
  assert.deepStrictEqual(ok.items, [
    { variantId: V1, numericId: '48300507562239', quantity: 3 },
    { variantId: V2, numericId: '48300507595007', quantity: 1 },
  ]);
  assert.equal(cartLinks.normalizeItems([{ variantId: V1, quantity: 999 }]).items[0].quantity, cartLinks.MAX_QTY);
  assert.match(cartLinks.normalizeItems([]).error, /at least one/);
  assert.match(cartLinks.normalizeItems(null).error, /at least one/);
  assert.match(cartLinks.normalizeItems([{ variantId: V1, quantity: 0 }]).error, /1 or more/);
  assert.match(cartLinks.normalizeItems([{ variantId: V1, quantity: 'abc' }]).error, /1 or more/);
  assert.match(cartLinks.normalizeItems([{ variantId: 'javascript:alert(1)', quantity: 1 }]).error, /Unknown product/);
  assert.match(cartLinks.normalizeItems([{ quantity: 1 }]).error, /Unknown product/);
  const many = Array.from({ length: cartLinks.MAX_LINES + 1 }, (_, i) => ({ variantId: `gid://shopify/ProductVariant/${i + 1}`, quantity: 1 }));
  assert.match(cartLinks.normalizeItems(many).error, /At most 20/);
});

test('cart link opens the cart page with the items and the cart id in its UTM tags', () => {
  const { items } = cartLinks.normalizeItems([{ variantId: V1, quantity: 2 }, { variantId: V2, quantity: 1 }]);
  const url = cartLinks.buildCartUrl('https://thakarkitchen.com', items, 'cfa6f81011');
  assert.equal(
    url,
    'https://thakarkitchen.com/cart/48300507562239:2,48300507595007:1?storefront=true&utm_source=whatsapp&utm_medium=chat&utm_campaign=cart_link&utm_content=cfa6f81011'
  );
  assert.match(cartLinks.newCartId(), /^[a-f0-9]{10}$/);
});

test('the chat cart an order came from, from its attributes', () => {
  assert.equal(cartLinks.cartIdOf(utm('cfa6f81011')), 'cfa6f81011');
  // Magic Checkout's own string, when the tags weren't split out.
  assert.equal(
    cartLinks.cartIdOf([{ key: 'rzp_3p_utm', value: 'utm_campaign:cart_link||utm_content:cfa6f81011||utm_medium:chat||utm_source:whatsapp' }]),
    'cfa6f81011'
  );
  // Split-out tags win over the string.
  assert.equal(cartLinks.cartIdOf([...utm('cfa6f81011'), { key: 'rzp_3p_utm', value: 'utm_source:facebook' }]), 'cfa6f81011');
  // Other campaigns and odd values are not cart links.
  assert.equal(cartLinks.cartIdOf(utm('cfa6f81011', { utm_source: 'facebook' })), null);
  assert.equal(cartLinks.cartIdOf(utm('cfa6f81011', { utm_campaign: 'diwali' })), null);
  assert.equal(cartLinks.cartIdOf(utm('<script>')), null);
  assert.equal(cartLinks.cartIdOf([]), null);
  assert.equal(cartLinks.cartIdOf(undefined), null);
});

test('orders keep the cart id when synced from Shopify', () => {
  assert.equal(mapOrder({ id: 'x', tags: [], customAttributes: utm('cfa6f81011') }).waCartId, 'cfa6f81011');
  assert.equal(mapOrder({ id: 'x', tags: [], customAttributes: [{ key: 'utm_source', value: 'facebook' }] }).waCartId, null);
  assert.equal(mapOrder({ id: 'x', tags: [] }).waCartId, null);
});

test('cart links matched to the orders that came from them', () => {
  const carts = [cartMsg('aaaaaaaaaa', SENT), cartMsg('bbbbbbbbbb', at(2 * DAY))];
  const tagged = { name: '#3451', placedAt: at(5 * DAY), waCartId: 'aaaaaaaaaa' };
  const untaggedSoon = { name: '#3452', placedAt: at(2 * DAY + HOUR), waCartId: null };
  const [first, second] = cartLinks.matchOrders(carts, [untaggedSoon, tagged]);
  // A tagged order is a sure match, however late.
  assert.deepStrictEqual(first, { order: tagged, exact: true });
  // An untagged order counts for the latest link before it.
  assert.deepStrictEqual(second, { order: untaggedSoon, exact: false });
});

test('cart link matching: time limits and orders tagged for other carts', () => {
  const carts = [cartMsg('aaaaaaaaaa', SENT)];
  const before = { name: '#1', placedAt: at(-HOUR), waCartId: null };
  const late = { name: '#2', placedAt: at(3 * DAY + HOUR), waCartId: null };
  const otherCart = { name: '#3', placedAt: at(HOUR), waCartId: 'cccccccccc' };
  assert.deepStrictEqual(cartLinks.matchOrders(carts, [before, late, otherCart]), [null]);
  const first = { name: '#4', placedAt: at(2 * HOUR), waCartId: null };
  const second = { name: '#5', placedAt: at(HOUR), waCartId: null };
  assert.equal(cartLinks.matchOrders(carts, [first, second])[0].order.name, '#5');
  // A newer link takes over orders placed after it.
  const two = [cartMsg('aaaaaaaaaa', SENT), cartMsg('bbbbbbbbbb', at(HOUR))];
  const after = { name: '#6', placedAt: at(2 * HOUR), waCartId: null };
  assert.deepStrictEqual(cartLinks.matchOrders(two, [after]), [null, { order: after, exact: false }]);
});

test('cart message lists the items, the total and the link', () => {
  const { text, total } = cartLinks.cartMessage(
    [
      { productTitle: 'Methi Papad', variantTitle: 'Pack of 2', price: 240, quantity: 2 },
      { productTitle: 'Kaju Curry', variantTitle: '', price: 235, quantity: 1 },
    ],
    'https://thakarkitchen.com/cart/1:2'
  );
  assert.equal(total, 715);
  assert.match(text, /• Methi Papad \(Pack of 2\) × 2 — ₹480/);
  assert.match(text, /• Kaju Curry × 1 — ₹235/);
  assert.match(text, /Items total: ₹715/);
  assert.ok(text.endsWith('\nhttps://thakarkitchen.com/cart/1:2'));
});
