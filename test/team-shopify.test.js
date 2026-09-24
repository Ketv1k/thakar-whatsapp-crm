const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const users = require('../src/services/users');
const { requireInboxAuth, ownerForChanges } = require('../src/middleware/auth');
const shopifyLive = require('../src/services/shopifyLive');
const { mergeFromShopify } = require('../src/services/customerSync');
const { mapDetails, orderGid } = require('../src/services/shopifyOrders');

function run(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body, req });
      },
    };
    mw(req, res, () => resolve({ next: true, req }));
  });
}

test('passwords are hashed and checked', () => {
  const stored = users.hashPassword('mango-1234-kite');
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('mango'));
  assert.equal(users.verifyPassword('mango-1234-kite', stored), true);
  assert.equal(users.verifyPassword('mango-1234-kitE', stored), false);
  assert.equal(users.verifyPassword('x', 'garbage'), false);
  assert.match(users.temporaryPassword(), /^[a-z]+-\d{4}-[a-z]+$/);
  assert.equal(users.passwordProblem('short'), 'Use at least 8 characters');
  assert.equal(users.passwordProblem('long enough'), null);
  assert.equal(users.cleanEmail(' Priya@Example.COM '), 'priya@example.com');
  assert.equal(users.cleanEmail('not-an-email'), null);
});

test('the access code logs in as the owner; anything else is refused', async () => {
  process.env.INBOX_API_KEY = 'the-owner-access-code-123';
  process.env.FOUNDER_NAME = 'Ketvik Thakar';
  const ok = await run(requireInboxAuth, { headers: { authorization: 'Bearer the-owner-access-code-123' } });
  assert.equal(ok.next, true);
  assert.equal(ok.req.user.role, 'owner');
  assert.equal(ok.req.user.name, 'Ketvik Thakar');
  assert.equal((await run(requireInboxAuth, { headers: {} })).status, 401);
  assert.equal((await run(requireInboxAuth, { headers: { authorization: 'Bearer nope' } })).status, 401);
});

test('team members can look but not change owner-only things', async () => {
  const team = { user: { role: 'team' } };
  assert.equal((await run(ownerForChanges, { ...team, method: 'GET' })).next, true);
  const blocked = await run(ownerForChanges, { ...team, method: 'POST' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /Only the owner/);
  assert.equal((await run(ownerForChanges, { user: { role: 'owner' }, method: 'POST' })).next, true);
});

test('Shopify instant updates: only calls signed with the app secret are accepted', () => {
  const body = Buffer.from(JSON.stringify({ id: 1 }));
  const secret = 'shpss_test_secret';
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(shopifyLive.verifyHmac(body, good, secret), true);
  assert.equal(shopifyLive.verifyHmac(Buffer.from('{"id":2}'), good, secret), false);
  assert.equal(shopifyLive.verifyHmac(body, 'bad', secret), false);
  assert.equal(shopifyLive.verifyHmac(body, good, ''), false);
});

test('what each Shopify update does', () => {
  assert.deepEqual(shopifyLive.actionFor('orders/create', { admin_graphql_api_id: 'gid://shopify/Order/5' }), { kind: 'order', id: 'gid://shopify/Order/5' });
  assert.deepEqual(shopifyLive.actionFor('fulfillments/update', { order_id: 7 }), { kind: 'order', id: 'gid://shopify/Order/7' });
  assert.deepEqual(shopifyLive.actionFor('customers/update', { admin_graphql_api_id: 'gid://shopify/Customer/9' }), { kind: 'customer', id: 'gid://shopify/Customer/9' });
  assert.deepEqual(shopifyLive.actionFor('checkouts/update', {}), { kind: 'carts' });
  assert.deepEqual(shopifyLive.actionFor('inventory_levels/update', {}), { kind: 'stock' });
  assert.equal(shopifyLive.actionFor('shop/update', {}), null);
  assert.equal(shopifyLive.TOPICS.length, 11);
});

test('tag and note changes waiting for Shopify combine sensibly', () => {
  let p = shopifyLive.queueChange(null, { added: ['VIP'] });
  assert.deepEqual([p.tagsAdd, p.tagsRemove, p.note, p.v], [['VIP'], [], null, 1]);
  p = shopifyLive.queueChange(p, { removed: ['vip', 'Old'] });
  assert.deepEqual([p.tagsAdd, p.tagsRemove], [[], ['vip', 'Old']]);
  p = shopifyLive.queueChange(p, { added: ['Old'], note: 'Prefers evening delivery' });
  assert.deepEqual([p.tagsAdd, p.tagsRemove, p.note, p.v], [['Old'], ['vip'], 'Prefers evening delivery', 3]);
});

test("Shopify's tags and note win, but nothing typed here is lost", () => {
  const now = new Date('2026-09-24T10:00:00Z');
  // First time: our extra tag and note are kept and sent to Shopify.
  const first = mergeFromShopify({ tags: ['Jain', 'zoko'], notes: 'Less spicy', tagsPulledAt: null }, ['Zoko', 'Newsletter'], '', now);
  assert.deepEqual(first.tags, ['Zoko', 'Newsletter', 'Jain']);
  assert.equal(first.notes, 'Less spicy');
  assert.deepEqual(first.shopifyPush, { tagsAdd: ['Jain'], tagsRemove: [], note: 'Less spicy', v: 1 });
  // Both have a note: both are kept.
  assert.equal(mergeFromShopify({ tags: [], notes: 'Less spicy', tagsPulledAt: null }, [], 'VIP buyer', now).notes, 'VIP buyer\nLess spicy');
  // After that, Shopify is the source.
  assert.deepEqual(mergeFromShopify({ tags: ['Jain'], notes: 'x', tagsPulledAt: now }, ['Gift'], 'From Shopify', now), { tags: ['Gift'], notes: 'From Shopify', tagsPulledAt: now });
  // Changes still on their way to Shopify are not overwritten.
  assert.deepEqual(mergeFromShopify({ tags: ['Jain'], shopifyPush: { tagsAdd: ['Jain'] }, tagsPulledAt: now }, [], '', now), {});
  // A new customer just takes Shopify's.
  assert.deepEqual(mergeFromShopify(null, [' Gift ', 'gift', ''], null, now), { tags: ['Gift'], notes: '', tagsPulledAt: now });
});

test('an order from Shopify, ready for the panel next to the chat', () => {
  process.env.SHOPIFY_STORE_DOMAIN = 'esdjn0-th.myshopify.com';
  const o = mapDetails({
    id: 'gid://shopify/Order/6123',
    legacyResourceId: '6123',
    name: '#3451',
    createdAt: '2026-09-20T10:00:00Z',
    cancelledAt: null,
    note: 'Leave at the gate',
    tags: ['Gift'],
    displayFinancialStatus: 'PARTIALLY_PAID',
    displayFulfillmentStatus: 'FULFILLED',
    paymentGatewayNames: ['Razorpay'],
    currentTotalPriceSet: { shopMoney: { amount: '640.00', currencyCode: 'INR' } },
    currentSubtotalPriceSet: { shopMoney: { amount: '600.00' } },
    totalShippingPriceSet: { shopMoney: { amount: '40.00' } },
    totalOutstandingSet: { shopMoney: { amount: '541.00' } },
    shippingAddress: { name: 'Asha Test', address1: '12 MG Road', address2: '', city: 'Surat', province: 'Gujarat', zip: '395007', phone: '+919800000301' },
    lineItems: { edges: [{ node: { title: 'Kaju Curry', variantTitle: 'Default Title', quantity: 2, originalUnitPriceSet: { shopMoney: { amount: '300.00' } } } }] },
    fulfillments: [{ displayStatus: 'IN_TRANSIT', createdAt: '2026-09-21T10:00:00Z', trackingInfo: [{ company: 'India Post', number: 'EM123IN', url: 'https://track.example/EM123IN' }] }],
  });
  assert.equal(o.id, '6123');
  assert.deepEqual(o.items, [{ title: 'Kaju Curry', variant: '', quantity: 2, price: 300 }]);
  assert.deepEqual([o.total, o.subtotal, o.shipping, o.outstanding], [640, 600, 40, 541]);
  assert.deepEqual(o.address, ['Asha Test', '12 MG Road', 'Surat, Gujarat, 395007', '+919800000301']);
  assert.equal(o.tracking[0].url, 'https://track.example/EM123IN');
  assert.equal(o.adminUrl, 'https://admin.shopify.com/store/esdjn0-th/orders/6123');
  assert.equal(orderGid('6123'), 'gid://shopify/Order/6123');
  assert.equal(orderGid('abc'), null);
});
