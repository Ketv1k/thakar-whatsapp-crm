// Shopify Admin API access, via GraphQL (Shopify's current recommended surface -
// REST is being phased out; GraphQL also lets us get the customer + their latest
// order + fulfillment/tracking status in a single request).
const axios = require('axios');

function storeDomain() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error('SHOPIFY_STORE_DOMAIN not configured');
  return domain;
}

// Two ways to authenticate, depending on how the Shopify app was created:
//  - Dev Dashboard app: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET. We exchange
//    them for an access token via the client credentials grant. Those tokens
//    last 24h, so we cache one and fetch a fresh one shortly before expiry.
//  - Custom app made in the store admin: a permanent SHOPIFY_ADMIN_API_TOKEN.
let cachedToken = null; // { value, expiresAt }
let tokenRequest = null; // shared in-flight request, so concurrent calls fetch once

async function fetchClientCredentialsToken() {
  const { data } = await axios.post(
    `https://${storeDomain()}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
    { timeout: 10000 }
  );
  // Renew 5 minutes early so a request never goes out with an expiring token.
  return { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
}

async function accessToken() {
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
    if (!tokenRequest) {
      tokenRequest = fetchClientCredentialsToken()
        .then((token) => {
          cachedToken = token;
          return token.value;
        })
        .finally(() => {
          tokenRequest = null;
        });
    }
    return tokenRequest;
  }
  if (process.env.SHOPIFY_ADMIN_API_TOKEN) return process.env.SHOPIFY_ADMIN_API_TOKEN;
  throw new Error(
    'Shopify not configured: set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_API_TOKEN)'
  );
}

// Runs a GraphQL Admin API query and returns its `data`. Shopify reports query
// problems (missing scope, bad field) in `errors` with an HTTP 200, so those are
// thrown here - otherwise they'd be indistinguishable from "customer not found".
async function graphql(query, variables) {
  const token = await accessToken();
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';
  const { data } = await axios.post(
    `https://${storeDomain()}/admin/api/${version}/graphql.json`,
    { query, variables },
    {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );
  if (data.errors) {
    const detail = Array.isArray(data.errors)
      ? data.errors.map((e) => e.message).join('; ')
      : JSON.stringify(data.errors);
    throw new Error(`Shopify GraphQL error: ${detail}`);
  }
  return data.data;
}

// WhatsApp numbers arrive as digits only (e.g. "919876543210").
// Shopify stores phone numbers with a leading "+".
function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return `+${digits}`;
}

const FULFILLMENT_LABELS = {
  UNFULFILLED: "hasn't shipped yet",
  PARTIALLY_FULFILLED: 'has partially shipped',
  FULFILLED: 'has been shipped',
  RESTOCKED: 'was returned/restocked',
  IN_PROGRESS: 'is being packed',
  ON_HOLD: 'is on hold',
  SCHEDULED: 'is scheduled',
};

/**
 * Looks up the most recent order for a customer by their WhatsApp phone number.
 * Returns null if no matching customer/order is found.
 */
async function getLatestOrderStatusByPhone(phone) {
  const query = `
    query FindCustomerOrders($searchQuery: String!) {
      customers(first: 1, query: $searchQuery) {
        edges {
          node {
            id
            displayName
            orders(first: 1, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  name
                  createdAt
                  displayFulfillmentStatus
                  fulfillments(first: 1) {
                    trackingInfo {
                      number
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { searchQuery: `phone:${toE164(phone)}` });

  const customerEdge = data?.customers?.edges?.[0];
  const orderEdge = customerEdge?.node?.orders?.edges?.[0];
  if (!customerEdge || !orderEdge) return null;

  const order = orderEdge.node;
  const tracking = order.fulfillments?.[0]?.trackingInfo?.[0] || null;

  return {
    customerName: customerEdge.node.displayName,
    orderName: order.name, // e.g. "#1023"
    createdAt: order.createdAt,
    fulfillmentStatus: order.displayFulfillmentStatus,
    trackingNumber: tracking?.number || null,
    trackingUrl: tracking?.url || null,
  };
}

/**
 * Assembles a customer's order history for the CRM profile: how many orders,
 * how much they've spent (lifetime), when they last ordered, and their most
 * recent orders. Returns { found: false } when there's no matching customer.
 */
async function getCustomerSummaryByPhone(phone) {
  const query = `
    query CustomerSummary($searchQuery: String!) {
      customers(first: 1, query: $searchQuery) {
        edges {
          node {
            id
            displayName
            numberOfOrders
            amountSpent { amount currencyCode }
            orders(first: 5, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  name
                  createdAt
                  displayFulfillmentStatus
                  currentTotalPriceSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { searchQuery: `phone:${toE164(phone)}` });

  const node = data?.customers?.edges?.[0]?.node;
  if (!node) return { found: false };

  const orders = (node.orders?.edges || []).map((e) => ({
    name: e.node.name,
    createdAt: e.node.createdAt,
    fulfillmentStatus: e.node.displayFulfillmentStatus,
    total: Number(e.node.currentTotalPriceSet?.shopMoney?.amount || 0),
  }));

  return {
    found: true,
    customerName: node.displayName || '',
    ordersCount: Number(node.numberOfOrders || 0),
    totalSpent: Number(node.amountSpent?.amount || 0),
    currency: node.amountSpent?.currencyCode || 'INR',
    lastOrderAt: orders[0]?.createdAt || null,
    orders,
  };
}

// Recent customers who have ordered and have a phone on file - used by test
// mode's "pretend to be a real customer" picker.
async function listRecentCustomersWithPhone(limit = 15) {
  const data = await graphql(
    `query RecentCustomers {
      customers(first: 50, sortKey: UPDATED_AT, reverse: true, query: "orders_count:>0") {
        edges { node { displayName phone numberOfOrders } }
      }
    }`,
    {}
  );
  const seen = new Set();
  return (data?.customers?.edges || [])
    .map((e) => e.node)
    .filter((c) => c.phone)
    .map((c) => ({
      name: c.displayName || '',
      phone: c.phone.replace(/\D/g, ''),
      ordersCount: Number(c.numberOfOrders || 0),
    }))
    .filter((c) => !seen.has(c.phone) && seen.add(c.phone))
    .slice(0, limit);
}

// Turns a lookup result into a short, friendly WhatsApp reply.
function composeStatusReplyText(orderInfo) {
  if (!orderInfo) {
    return "I couldn't find a recent order under this number. Could you share your order number so I can check for you?";
  }
  const statusPhrase = FULFILLMENT_LABELS[orderInfo.fulfillmentStatus] || 'is being processed';
  let text = `Your order ${orderInfo.orderName} ${statusPhrase}.`;
  if (orderInfo.trackingUrl) {
    text += ` Track it here: ${orderInfo.trackingUrl}`;
  } else if (orderInfo.trackingNumber) {
    text += ` Tracking number: ${orderInfo.trackingNumber}`;
  }
  return text;
}

module.exports = {
  getLatestOrderStatusByPhone,
  getCustomerSummaryByPhone,
  listRecentCustomersWithPhone,
  composeStatusReplyText,
  toE164,
};
