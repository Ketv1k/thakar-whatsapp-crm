// Works out a customer's standing automatically from their Shopify order
// history - no manual tagging. Deliberately simple (three buckets) so it's easy
// to reason about and tune. Thresholds are env-tunable for when order volumes
// or basket sizes change.
//
//   new        - hasn't ordered, or just once
//   returning  - has come back (>= 2 orders)
//   vip        - a loyal / high-value regular (many orders OR high lifetime spend)

const STATUS_LABELS = {
  new: 'New customer',
  returning: 'Returning',
  vip: 'VIP',
};

function thresholds() {
  return {
    returningOrders: Number(process.env.CRM_RETURNING_ORDERS || 2),
    vipOrders: Number(process.env.CRM_VIP_ORDERS || 5),
    vipSpend: Number(process.env.CRM_VIP_SPEND || 5000), // lifetime spend, store currency
  };
}

function classify(ordersCount = 0, totalSpent = 0) {
  const t = thresholds();
  const orders = Number(ordersCount) || 0;
  const spent = Number(totalSpent) || 0;

  if (orders >= t.vipOrders || spent >= t.vipSpend) return 'vip';
  if (orders >= t.returningOrders) return 'returning';
  return 'new';
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

module.exports = { classify, statusLabel, STATUS_LABELS };
