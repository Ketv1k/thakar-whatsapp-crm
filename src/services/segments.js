// Customer groups for the Customers page and campaigns. Built from the
// customer records the Shopify sync keeps up to date.
const Customer = require('../models/Customer');

const DAY = 24 * 60 * 60 * 1000;

function lapsedDays() {
  return Number(process.env.CRM_LAPSED_DAYS || 45);
}

const SEGMENTS = [
  { key: 'all', label: 'Everyone' },
  { key: 'vip', label: 'VIP' },
  { key: 'returning', label: 'Returning' },
  { key: 'one_order', label: 'Ordered once' },
  { key: 'lapsed', label: `Lapsed ${lapsedDays()}+ days` },
  { key: 'no_orders', label: 'No orders yet' },
  { key: 'opted_in', label: 'Opted in to offers' },
];

function segmentQuery(key, now = new Date()) {
  switch (key) {
    case 'vip':
      return { status: 'vip' };
    case 'returning':
      return { status: 'returning' };
    case 'one_order':
      return { ordersCount: 1 };
    case 'lapsed':
      return { lastOrderAt: { $ne: null, $lt: new Date(now.getTime() - lapsedDays() * DAY) } };
    case 'no_orders':
      return { $or: [{ ordersCount: 0 }, { ordersCount: null }], lastOrderAt: null };
    case 'opted_in':
      return { optedInMarketing: true };
    default:
      return {};
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Group + optional tag + optional search text, as one Mongo filter.
function customerFilter({ segment = 'all', tag = '', q = '' } = {}, now = new Date()) {
  const parts = [segmentQuery(segment, now)];
  if (tag) parts.push({ tags: tag });
  const text = String(q || '').trim().slice(0, 60);
  if (text) {
    const re = new RegExp(escapeRegex(text), 'i');
    const digits = text.replace(/\D/g, '');
    const or = [{ name: re }, { city: re }, { tags: re }];
    if (digits.length >= 3) or.push({ phone: { $regex: escapeRegex(digits) } });
    parts.push({ $or: or });
  }
  const nonEmpty = parts.filter((p) => Object.keys(p).length);
  return nonEmpty.length === 0 ? {} : nonEmpty.length === 1 ? nonEmpty[0] : { $and: nonEmpty };
}

async function counts({ tag = '' } = {}) {
  const out = {};
  await Promise.all(
    SEGMENTS.map(async (s) => {
      out[s.key] = await Customer.countDocuments(customerFilter({ segment: s.key, tag }));
    })
  );
  return out;
}

function isSegment(key) {
  return SEGMENTS.some((s) => s.key === key);
}

module.exports = { SEGMENTS, segmentQuery, customerFilter, counts, isSegment, lapsedDays };
