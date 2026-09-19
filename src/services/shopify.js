// Shopify Admin API access, via GraphQL (Shopify's current recommended surface -
// REST is being phased out; GraphQL also lets us get the customer + their latest
// order + fulfillment/tracking status in a single request).
const axios = require('axios');

function client() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-07';

  if (!domain || !token) {
    throw new Error('SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN not configured');
  }

  return axios.create({
    baseURL: `https://${domain}/admin/api/${version}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
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
  const api = client();
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

  const { data } = await api.post('/graphql.json', {
    query,
    variables: { searchQuery: `phone:${toE164(phone)}` },
  });

  const customerEdge = data?.data?.customers?.edges?.[0];
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

module.exports = { getLatestOrderStatusByPhone, composeStatusReplyText, toE164 };
