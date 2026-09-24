// One Shopify order in full, for the panel next to a chat, and the things
// the team can do to it from there: add a note or tag, send the tracking
// link, cancel it. Every change goes straight to Shopify.
const shopify = require('./shopify');

function orderGid(id) {
  const n = String(id || '').split('/').pop();
  return /^\d{1,20}$/.test(n) ? `gid://shopify/Order/${n}` : null;
}

const DETAIL_FIELDS = `
  id legacyResourceId name createdAt cancelledAt closed note tags
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames statusPageUrl
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  currentSubtotalPriceSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  shippingAddress { name address1 address2 city province zip phone }
  customer { id displayName phone }
  lineItems(first: 50) { edges { node { title variantTitle quantity originalUnitPriceSet { shopMoney { amount } } } } }
  fulfillments(first: 10) { displayStatus createdAt trackingInfo(first: 1) { company number url } }
`;

const money = (set) => Number(set?.shopMoney?.amount || 0);

// Shopify order -> what the panel shows. Pure.
function mapDetails(o) {
  const tracking = (o.fulfillments || []).map((f) => ({ status: f.displayStatus, at: f.createdAt, ...(f.trackingInfo?.[0] || {}) })).filter((t) => t.url || t.number);
  const a = o.shippingAddress;
  return {
    id: o.legacyResourceId || String(o.id).split('/').pop(),
    name: o.name,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    closed: !!o.closed,
    note: o.note || '',
    tags: o.tags || [],
    payment: o.displayFinancialStatus,
    fulfillment: o.displayFulfillmentStatus,
    gateways: o.paymentGatewayNames || [],
    statusPageUrl: o.statusPageUrl || null,
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode || 'INR',
    total: money(o.currentTotalPriceSet),
    subtotal: money(o.currentSubtotalPriceSet),
    shipping: money(o.totalShippingPriceSet),
    outstanding: money(o.totalOutstandingSet),
    address: a ? [a.name, a.address1, a.address2, [a.city, a.province, a.zip].filter(Boolean).join(', '), a.phone].filter(Boolean) : [],
    customer: o.customer ? { id: o.customer.id, name: o.customer.displayName, phone: o.customer.phone } : null,
    items: (o.lineItems?.edges || []).map((e) => ({
      title: e.node.title,
      variant: e.node.variantTitle && e.node.variantTitle !== 'Default Title' ? e.node.variantTitle : '',
      quantity: e.node.quantity,
      price: money(e.node.originalUnitPriceSet),
    })),
    tracking,
    adminUrl: shopify.adminOrderUrl(o.id),
  };
}

async function details(id) {
  const gid = orderGid(id);
  if (!gid) return null;
  const data = await shopify.graphql(`query Order($id: ID!) { order(id: $id) { ${DETAIL_FIELDS} } }`, { id: gid });
  return data.order ? mapDetails(data.order) : null;
}

function userError(errors) {
  const e = (errors || [])[0];
  return e ? Object.assign(new Error(`Shopify said: ${e.message}`), { status: 400, expose: true }) : null;
}

// Adds a dated line to the order's note (keeps what's there).
async function addNote(id, text, by) {
  const order = await details(id);
  if (!order) return null;
  const stamp = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const line = `[${stamp}${by ? `, ${by}` : ''}] ${String(text).trim().slice(0, 500)}`;
  const note = order.note ? `${order.note}\n${line}` : line;
  const data = await shopify.graphql(
    `mutation Note($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { message } } }`,
    { input: { id: orderGid(id), note } }
  );
  const err = userError(data.orderUpdate.userErrors);
  if (err) throw err;
  return details(id);
}

async function addTag(id, tag) {
  const clean = String(tag || '').trim().slice(0, 40);
  if (!clean) throw Object.assign(new Error('Type a tag'), { status: 400, expose: true });
  const data = await shopify.graphql(
    `mutation Tag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: orderGid(id), tags: [clean] }
  );
  const err = userError(data.tagsAdd.userErrors);
  if (err) throw err;
  return details(id);
}

// Cancels in Shopify and puts the items back in stock. No refund is made
// here: if they paid online, refund them in Razorpay.
async function cancel(id, { reason = 'CUSTOMER', by = '' } = {}) {
  const reasons = ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'STAFF', 'OTHER'];
  const data = await shopify.graphql(
    `mutation Cancel($orderId: ID!, $reason: OrderCancelReason!, $staffNote: String) {
      orderCancel(orderId: $orderId, reason: $reason, restock: true, notifyCustomer: false, staffNote: $staffNote) {
        job { id } orderCancelUserErrors { message }
      }
    }`,
    { orderId: orderGid(id), reason: reasons.includes(reason) ? reason : 'CUSTOMER', staffNote: `Cancelled from the WhatsApp inbox${by ? ` by ${by}` : ''}` }
  );
  const err = userError(data.orderCancel.orderCancelUserErrors);
  if (err) throw err;
  return { ok: true };
}

module.exports = { orderGid, mapDetails, details, addNote, addTag, cancel };
