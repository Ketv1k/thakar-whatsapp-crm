const test = require('node:test');
const assert = require('node:assert');
const { normalizePhone } = require('../src/utils/phone');
const { isQuietTime } = require('../src/utils/time');
const { formatMoney } = require('../src/utils/money');
const templates = require('../src/services/templates');
const { dueEvents } = require('../src/services/orderEvents');
const { mapOrder, paramsFor } = require('../src/services/orderSync');
const cartRecovery = require('../src/services/cartRecovery');
const reorder = require('../src/services/reorder');
const { isBack } = require('../src/services/backInStock');
const { detectKeyword } = require('../src/services/optIn');
const { customerFilter } = require('../src/services/segments');
const campaigns = require('../src/services/campaigns');
const pricing = require('../src/services/pricing');
const { mapCustomer } = require('../src/services/customerSync');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-23T08:00:00Z'); // 1:30 pm in India
const ON = new Date('2026-09-20T00:00:00Z');
const on = (options = {}) => ({ enabled: true, enabledAt: ON, options });
const off = () => ({ enabled: false, enabledAt: null, options: {} });
const allOn = () => ({
  order_confirmed: on(),
  cod_confirmation: on(),
  order_shipped: on(),
  order_out_for_delivery: on(),
  order_delivered: on(),
});

test('phone numbers become digits with the country code', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('9876543210'), '919876543210');
  assert.equal(normalizePhone('919876543210'), '919876543210');
  assert.equal(normalizePhone('+1 (415) 555-0100'), '14155550100');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('quiet hours are 9pm to 9am India time by default', () => {
  delete process.env.QUIET_HOURS;
  assert.equal(isQuietTime(new Date('2026-09-23T08:00:00Z')), false); // 1:30 pm
  assert.equal(isQuietTime(new Date('2026-09-23T16:00:00Z')), true); // 9:30 pm
  assert.equal(isQuietTime(new Date('2026-09-23T02:00:00Z')), true); // 7:30 am
  assert.equal(isQuietTime(new Date('2026-09-23T03:40:00Z')), false); // 9:10 am
});

test('money is shown the Indian way', () => {
  assert.equal(formatMoney(1151), '₹1,151');
  assert.equal(formatMoney(125000), '₹1,25,000');
  assert.equal(formatMoney(99.5), '₹99.5');
});

test('templates render, and build the send call WhatsApp expects', () => {
  const cod = templates.CATALOG.find((t) => t.name === 'cod_confirmation');
  const t = { name: cod.name, language: 'en', components: templates.buildComponents({ body: cod.body, examples: cod.examples, quickReplies: cod.quickReplies }) };
  assert.equal(templates.paramCount(t), 3);
  assert.deepEqual(templates.quickReplies(t), ['Confirm order', 'Cancel order']);
  assert.match(templates.render(t, ['Priya', '#3451', '₹1,151']), /^Hi Priya, thank you for your order #3451 .*₹1,151\./);

  const components = templates.sendComponents(t, {
    bodyParams: ['Priya\nShah', '#3451', ''],
    quickReplyPayloads: { 'Confirm order': 'COD_CONFIRM:abc', 'Cancel order': 'COD_CANCEL:abc' },
  });
  assert.deepEqual(components[0], {
    type: 'body',
    parameters: [
      { type: 'text', text: 'Priya Shah' }, // no line breaks allowed in variables
      { type: 'text', text: '#3451' },
      { type: 'text', text: '-' }, // never empty
    ],
  });
  assert.deepEqual(components[1], { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'COD_CONFIRM:abc' }] });
  assert.equal(components[2].index, '1');
});

test('every built-in template follows WhatsApp\'s writing rules', () => {
  for (const t of templates.CATALOG) {
    assert.equal(templates.validateBody(t.body), null, t.name);
    const count = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].length;
    assert.equal(t.examples.length, count, `${t.name} needs an example per blank`);
    if (t.category === 'MARKETING') assert.ok((t.quickReplies || []).includes(templates.STOP_BUTTON), `${t.name} needs a stop button`);
  }
});

test('new templates are checked before going to Meta', () => {
  assert.match(templates.validateBody('{{1}}, big Diwali sale on now at Thakar Kitchen'), /start or end/);
  assert.match(templates.validateBody('Big Diwali sale on now, {{1}}'), /start or end/);
  assert.match(templates.validateBody('Hi {{1}}, sale {{3}} on now at our kitchen'), /in order/);
  assert.match(templates.validateBody('Hi {{1}} {{2}}, sale on now at our kitchen'), /between two blanks/);
  assert.equal(templates.validateBody('Hi {{1}}, our Diwali sweets box is here. Order before Sunday!'), null);
  assert.equal(templates.slugify('Diwali offer 2026!'), 'diwali_offer_2026');
});

test('image templates send the photo link in the heading', () => {
  const t = { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}, new thali is here for you to try!' }] };
  const c = templates.sendComponents(t, { bodyParams: ['Priya'], headerImageUrl: 'https://cdn.shopify.com/x.jpg' });
  assert.deepEqual(c[0], { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.shopify.com/x.jpg' } }] });
  assert.equal(templates.unsupportedReason({ components: [{ type: 'HEADER', format: 'VIDEO' }] }), 'It has a video heading');
});

// ---- Orders ----
function order(extra = {}) {
  return {
    phone: '919876543210',
    placedAt: new Date(NOW.getTime() - HOUR),
    isCod: false,
    notified: {},
    ...extra,
  };
}

test('a new prepaid order gets "order confirmed"', () => {
  assert.deepEqual(dueEvents(order(), allOn(), NOW), { send: ['confirmed'], skip: [] });
});

test('a new COD order gets the confirm/cancel request instead', () => {
  assert.deepEqual(dueEvents(order({ isCod: true }), allOn(), NOW).send, ['cod_request']);
  // With COD confirmation off, it's a normal confirmation.
  const autos = { ...allOn(), cod_confirmation: off() };
  assert.deepEqual(dueEvents(order({ isCod: true }), autos, NOW).send, ['confirmed']);
});

test('nothing is sent for orders placed before the automation was switched on', () => {
  const old = order({ placedAt: new Date(ON.getTime() - HOUR) });
  assert.deepEqual(dueEvents(old, allOn(), new Date(ON.getTime() + HOUR)).send, []);
});

test('updates too old to be useful are dropped', () => {
  assert.deepEqual(dueEvents(order({ placedAt: new Date(NOW.getTime() - 30 * HOUR) }), allOn(), NOW).send, []);
  const lateDelivery = order({ placedAt: new Date(NOW.getTime() - 5 * DAY), deliveredAt: new Date(NOW.getTime() - 3 * DAY), notified: { confirmed: ON } });
  assert.deepEqual(dueEvents(lateDelivery, allOn(), NOW).send, []);
});

test('only the newest shipping update goes when several are due', () => {
  const o = order({
    shippedAt: new Date(NOW.getTime() - 3 * HOUR),
    outForDeliveryAt: new Date(NOW.getTime() - 2 * HOUR),
    deliveredAt: new Date(NOW.getTime() - HOUR),
    notified: { confirmed: ON },
  });
  const r = dueEvents(o, allOn(), NOW);
  assert.deepEqual(r.send, ['delivered']);
  assert.deepEqual(r.skip.map((s) => s.event), ['shipped']);
});

test('an order that shipped before we noticed it skips "confirmed"', () => {
  const r = dueEvents(order({ shippedAt: new Date(NOW.getTime() - 10 * 60 * 1000) }), allOn(), NOW);
  assert.deepEqual(r.send, ['shipped']);
  assert.deepEqual(r.skip.map((s) => s.event), ['confirmed']);
});

test('updates already sent, cancelled and Shopify test orders are left alone', () => {
  assert.deepEqual(dueEvents(order({ notified: { confirmed: NOW } }), allOn(), NOW).send, []);
  assert.deepEqual(dueEvents(order({ cancelledAt: NOW }), allOn(), NOW).send, []);
  assert.deepEqual(dueEvents(order({ shopifyTest: true }), allOn(), NOW).send, []);
  assert.deepEqual(dueEvents(order({ phone: null }), allOn(), NOW).send, []);
});

test('Shopify orders are read correctly, including Razorpay partial COD', () => {
  const o = mapOrder({
    id: 'gid://shopify/Order/1',
    name: '#3430',
    createdAt: '2026-09-23T06:00:00Z',
    updatedAt: '2026-09-23T06:05:00Z',
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PARTIALLY_PAID',
    displayFulfillmentStatus: 'FULFILLED',
    paymentGatewayNames: ['Razorpay'],
    tags: ['Magic', 'razorpay_partial_cod', 'upi'],
    statusPageUrl: 'https://thakarkitchen.com/status',
    currentTotalPriceSet: { shopMoney: { amount: '1450.0', currencyCode: 'INR' } },
    totalOutstandingSet: { shopMoney: { amount: '1351.0' } },
    phone: null,
    customer: { id: 'gid://shopify/Customer/9', firstName: 'Pankti', displayName: 'Pankti Shah', phone: '+919876543210' },
    shippingAddress: { phone: '+919999999999', firstName: 'P' },
    lineItems: { edges: [{ node: { title: 'Bateta', quantity: 1, product: { id: 'gid://shopify/Product/5', handle: 'bateta', onlineStoreUrl: null } } }] },
    fulfillments: [
      { id: 'f1', createdAt: '2026-09-23T07:00:00Z', updatedAt: '2026-09-23T07:00:00Z', status: 'SUCCESS', displayStatus: 'FULFILLED', deliveredAt: null, trackingInfo: [{ company: 'India Post', number: 'EZ1', url: 'https://track/EZ1' }] },
      { id: 'f0', createdAt: '2026-09-23T06:30:00Z', updatedAt: '2026-09-23T06:30:00Z', status: 'CANCELLED', displayStatus: 'CANCELED', trackingInfo: [] },
    ],
  });
  assert.equal(o.phone, '919876543210');
  assert.equal(o.isCod, true);
  assert.equal(o.outstanding, 1351);
  assert.equal(o.fulfillments.length, 1);
  assert.equal(o.shippedAt.toISOString(), '2026-09-23T07:00:00.000Z');
  assert.equal(o.items[0].url, 'https://thakarkitchen.com/products/bateta');
  assert.deepEqual(paramsFor('cod_request', o), ['Pankti', '#3430', '₹1,351']);
  assert.deepEqual(paramsFor('shipped', o), ['Pankti', '#3430', 'https://track/EZ1']);
  assert.equal(mapOrder({ id: 'x', paymentGatewayNames: ['Cash on Delivery (COD)'], tags: [] }).isCod, true);
  assert.equal(mapOrder({ id: 'x', paymentGatewayNames: ['Razorpay'], tags: ['Magic', 'upi'] }).isCod, false);
});

// ---- Carts ----
function cart(extra = {}) {
  return {
    phone: '919876543210',
    url: 'https://thakarkitchen.com/cart/x',
    checkoutCreatedAt: new Date(NOW.getTime() - 2 * HOUR),
    ...extra,
  };
}
const cartCtx = (extra = {}) => ({ automation: on({ delayMinutes: 60 }), optedIn: true, orderedSince: false, recentReminder: false, now: NOW, ...extra });

test('a cart left over an hour ago gets one reminder', () => {
  assert.equal(cartRecovery.decide(cart(), cartCtx()).action, 'send');
  assert.equal(cartRecovery.decide(cart({ checkoutCreatedAt: new Date(NOW.getTime() - 20 * 60 * 1000) }), cartCtx()).action, 'wait');
  assert.equal(cartRecovery.decide(cart({ remindedAt: NOW }), cartCtx()).action, 'skip');
});

test('no cart reminder without opt-in, after an order, twice a day, or at night', () => {
  assert.equal(cartRecovery.decide(cart(), cartCtx({ optedIn: false })).reason, 'Not opted in to offers');
  assert.equal(cartRecovery.decide(cart(), cartCtx({ orderedSince: true })).reason, 'They placed an order');
  assert.equal(cartRecovery.decide(cart(), cartCtx({ recentReminder: true })).action, 'skip');
  assert.equal(cartRecovery.decide(cart({ checkoutCreatedAt: new Date(NOW.getTime() - 30 * HOUR) }), cartCtx()).reason, 'Too old for a reminder');
  const night = new Date('2026-09-23T17:00:00Z'); // 10:30 pm
  const late = cart({ checkoutCreatedAt: new Date(night.getTime() - 2 * HOUR) });
  assert.equal(cartRecovery.decide(late, cartCtx({ now: night })).action, 'wait');
  assert.equal(cartRecovery.decide(late, cartCtx({ now: night, ignoreQuietHours: true })).action, 'send');
  assert.equal(cartRecovery.decide(cart(), cartCtx({ automation: off() })).action, 'wait');
});

test('Magic Checkout carts link back into Magic Checkout on the shop\'s own domain', () => {
  const store = 'https://thakarkitchen.com';
  const node = {
    id: 'gid://shopify/AbandonedCheckout/1',
    abandonedCheckoutUrl: 'https://thakarkitchen.com/123/checkouts/ac/abc/recover?key=k',
    customer: { firstName: 'Riya', phone: null },
    shippingAddress: null,
    customAttributes: [
      { key: 'magic_checkout_url', value: 'https://esdjn0-th.myshopify.com/cart?magic_order_id=order_TfVyvTRbSrxmon' },
      { key: 'checkout_whatsapp_consent', value: 'true' },
      { key: 'drop_off_step', value: 'Payment Attempted' },
      { key: 'contact', value: '+91 98765 43210' },
    ],
    lineItems: { edges: [{ node: { title: 'Dal Dhokali', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/111' } } }] },
    createdAt: '2026-09-23T06:00:00Z',
  };
  const c = cartRecovery.mapCheckout(node, store);
  assert.equal(c.url, 'https://thakarkitchen.com/cart?magic_order_id=order_TfVyvTRbSrxmon');
  assert.equal(c.linkType, 'magic');
  assert.equal(c.whatsappConsent, true);
  assert.equal(c.dropOffStep, 'Payment Attempted');
  assert.equal(c.phone, '919876543210'); // from Magic's contact field
  assert.equal(c.shopifyUrl, node.abandonedCheckoutUrl);

  // No Magic link: the cart page with the same products (Checkout there opens Magic).
  const plain = { ...node, customAttributes: [] };
  const variants = { edges: [
    { node: { title: 'A', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/111' } } },
    { node: { title: 'B', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/222' } } },
  ] };
  assert.deepEqual(cartRecovery.recoveryLink({ ...plain, lineItems: variants }, store), {
    url: 'https://thakarkitchen.com/cart/111:2,222:1?storefront=true',
    linkType: 'cart',
  });
  // Nothing better: Shopify's own link.
  assert.equal(cartRecovery.recoveryLink({ ...plain, lineItems: { edges: [{ node: { title: 'C', quantity: 1, variant: null } }] } }, store).linkType, 'shopify');
  assert.equal(cartRecovery.mapCheckout({ ...plain, customAttributes: [{ key: 'checkout_whatsapp_consent', value: 'false' }] }, store).whatsappConsent, false);
});

test('consent given at checkout counts for the cart reminder; a no or a STOP always wins', () => {
  const ctx = cartCtx({ optedIn: false });
  assert.equal(cartRecovery.decide(cart({ whatsappConsent: true }), ctx).action, 'send');
  assert.equal(cartRecovery.decide(cart({ whatsappConsent: null }), ctx).reason, 'Not opted in to offers');
  assert.equal(cartRecovery.decide(cart({ whatsappConsent: false }), cartCtx({ optedIn: true })).reason, 'Said no to WhatsApp messages at checkout');
  assert.equal(cartRecovery.decide(cart({ whatsappConsent: true }), cartCtx({ optedIn: false, optedOut: true })).reason, 'They replied STOP');
});

test('cart items read naturally', () => {
  assert.equal(cartRecovery.itemsLabel(['Kaju Curry']), 'Kaju Curry');
  assert.equal(cartRecovery.itemsLabel(['Kaju Curry', 'Dal Tadka']), 'Kaju Curry and Dal Tadka');
  assert.equal(cartRecovery.itemsLabel(['A', 'B', 'C']), 'A and 2 more');
  assert.equal(cartRecovery.itemsLabel([]), 'your favourites');
});

// ---- Reorder ----
const reorderCtx = (extra = {}) => ({ automation: on({ days: 21 }), optedIn: true, newerOrder: false, recentReminder: false, now: NOW, ...extra });

test('reorder reminders go 21 days after shipping, once', () => {
  const shipped = (days) => order({ shippedAt: new Date(NOW.getTime() - days * DAY) });
  assert.equal(reorder.decide(shipped(22), reorderCtx()).action, 'send');
  assert.equal(reorder.decide(shipped(10), reorderCtx()).action, 'wait');
  assert.equal(reorder.decide(shipped(40), reorderCtx()).action, 'skip');
  assert.equal(reorder.decide(shipped(22), reorderCtx({ newerOrder: true })).reason, 'They ordered again');
  assert.equal(reorder.decide(shipped(22), reorderCtx({ optedIn: false })).action, 'skip');
  assert.equal(reorder.decide(shipped(22), reorderCtx({ recentReminder: true })).action, 'skip');
  assert.equal(reorder.decide({ ...shipped(22), notified: { reorder: NOW } }, reorderCtx()).action, 'skip');
  assert.equal(reorder.productLabel({ items: [{ title: 'Kaju Curry' }, { title: 'Dal' }] }), 'Kaju Curry and more');
});

// ---- Back in stock ----
test('back in stock means the waited-for size is available again', () => {
  const product = { active: true, inStock: false, variants: [{ id: 'v1', available: false }, { id: 'v2', available: true }] };
  assert.equal(isBack({ variantId: 'v1' }, product), false);
  assert.equal(isBack({ variantId: 'v2' }, product), true);
  assert.equal(isBack({}, product), false);
  assert.equal(isBack({}, { ...product, inStock: true }), true);
  assert.equal(isBack({}, { ...product, active: false, inStock: true }), false);
});

// ---- Opt-in ----
test('STOP and START are understood only as whole messages', () => {
  assert.equal(detectKeyword('STOP'), 'stop');
  assert.equal(detectKeyword('Stop promotions'), 'stop');
  assert.equal(detectKeyword(' unsubscribe! '), 'stop');
  assert.equal(detectKeyword('Start'), 'start');
  assert.equal(detectKeyword('please stop sending wrong items'), null);
  assert.equal(detectKeyword('when will you start delivery?'), null);
});

// ---- Customers & campaigns ----
test('customer groups build the right filters', () => {
  assert.deepEqual(customerFilter({ segment: 'vip' }), { status: 'vip' });
  assert.deepEqual(customerFilter({ segment: 'all' }), {});
  const lapsed = customerFilter({ segment: 'lapsed' }, NOW);
  assert.equal(lapsed.lastOrderAt.$lt.toISOString(), new Date(NOW.getTime() - 45 * DAY).toISOString());
  const withTag = customerFilter({ segment: 'opted_in', tag: 'Jain' });
  assert.deepEqual(withTag, { $and: [{ optedInMarketing: true }, { tags: 'Jain' }] });
});

test('campaign audiences are opted-in only, with a gap between offers', () => {
  const f = campaigns.audienceFilter({ segment: 'vip', tag: '' }, NOW);
  assert.deepEqual(f.$and[0], { status: 'vip' });
  assert.deepEqual(f.$and[1], { optedInMarketing: true });
  assert.equal(f.$and[2].$or[1].lastMarketingAt.$lt.toISOString(), new Date(NOW.getTime() - 24 * HOUR).toISOString());
});

test('campaign blanks fill with first names or fixed text', () => {
  const c = { bodyParams: [{ source: 'first_name' }, { source: 'text', text: 'DIWALI10' }] };
  assert.deepEqual(campaigns.paramsFor(c, { name: 'Priya Shah' }), ['Priya', 'DIWALI10']);
  assert.deepEqual(campaigns.paramsFor(c, { name: '919876543210' }), ['there', 'DIWALI10']);
  const t = { name: 'x', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, use code {{2}} today at our kitchen' }] };
  process.env.TEST_MODE = 'true';
  assert.equal(campaigns.problems({ bodyParams: [{ source: 'first_name' }] }, t), 'Fill in blank {{2}}.');
  assert.equal(campaigns.problems(c, t), null);
  assert.equal(campaigns.problems(c, null), 'Choose a message template.');
  delete process.env.TEST_MODE;
});

test('costs include GST', () => {
  delete process.env.WA_PRICE_MARKETING;
  const m = pricing.estimate(100, 'MARKETING');
  assert.equal(m.each, 1.02);
  assert.equal(m.total, 101.85);
  assert.equal(pricing.estimate(10, 'UTILITY').each, 0.14);
});

test('Shopify customers without a phone are skipped; others get a status', () => {
  assert.equal(mapCustomer({ id: 'c', phone: null, defaultAddress: null }), null);
  const c = mapCustomer({
    id: 'gid://shopify/Customer/1',
    displayName: 'Pankti Shah',
    phone: null,
    defaultAddress: { city: 'Rajkot', phone: '98765 43210' },
    numberOfOrders: '6',
    amountSpent: { amount: '3200.0', currencyCode: 'INR' },
    lastOrder: { createdAt: '2026-09-01T00:00:00Z' },
    smsMarketingConsent: { marketingState: 'SUBSCRIBED' },
    updatedAt: '2026-09-02T00:00:00Z',
  });
  assert.equal(c.phone, '919876543210');
  assert.equal(c.fields.status, 'vip');
  assert.equal(c.fields.city, 'Rajkot');
  assert.equal(c.fields.marketingConsent, 'SUBSCRIBED');
});
