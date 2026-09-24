// Customer groups for the Customers page and campaigns, built from the
// customer records the Shopify sync keeps up to date.
//
// Stages sort every customer who has ordered into exactly one group, by how
// many orders they've placed and how long ago the last one was. Filters narrow
// any group further (what they bought, spend, city...). Saved groups are a
// stage plus filters under a name (models/Group.js).
const Customer = require('../models/Customer');

const DAY = 24 * 60 * 60 * 1000;

function lapsedDays() {
  return Number(process.env.CRM_LAPSED_DAYS || 45);
}

// Shown as the groups on the Customers page, in this order.
const STAGES = [
  { key: 'all', label: 'Everyone', help: 'Every customer from Shopify and everyone who has messaged you.' },
  { key: 'new', label: 'New', help: 'First order in the last 30 days.' },
  { key: 'second_order', label: 'Needs 2nd order', help: 'Ordered once, 30 to 120 days ago. The easiest people to bring back.' },
  { key: 'loyal', label: 'Loyal', help: 'Two or more orders, the latest in the last 90 days.' },
  { key: 'vip', label: 'VIP', help: 'Your best customers (5+ orders or ₹5,000+ spent) who ordered in the last 6 months.' },
  { key: 'at_risk', label: 'At risk', help: 'Ordered two or more times, but not in the last 90 days.' },
  { key: 'lost', label: 'Lost', help: "Ordered once and not in 120 days, or regulars who haven't ordered in 6 months." },
  { key: 'no_orders', label: 'No orders yet', help: "Messaged you or signed up, but haven't ordered." },
];

// Older groups, still understood so saved campaigns keep working.
const LEGACY = {
  returning: 'Returning',
  one_order: 'Ordered once',
  lapsed: `Lapsed ${lapsedDays()}+ days`,
  opted_in: 'Opted in to offers',
};

const SEGMENTS = STAGES.map(({ key, label, help }) => ({ key, label, help }));

function ago(now, days) {
  return new Date(now.getTime() - days * DAY);
}

function segmentQuery(key, now = new Date()) {
  const notVip = { status: { $ne: 'vip' } };
  const once = { ordersCount: 1 };
  const repeat = { ordersCount: { $gte: 2 } };
  switch (key) {
    case 'new':
      return { ...once, ...notVip, lastOrderAt: { $gte: ago(now, 30) } };
    case 'second_order':
      return { ...once, ...notVip, lastOrderAt: { $gte: ago(now, 120), $lt: ago(now, 30) } };
    case 'loyal':
      return { ...repeat, ...notVip, lastOrderAt: { $gte: ago(now, 90) } };
    case 'vip':
      return { status: 'vip', lastOrderAt: { $gte: ago(now, 180) } };
    case 'at_risk':
      return { ...repeat, ...notVip, lastOrderAt: { $gte: ago(now, 180), $lt: ago(now, 90) } };
    case 'lost':
      return {
        $or: [
          { ordersCount: { $gte: 1 }, lastOrderAt: { $lt: ago(now, 180) } },
          { ...once, ...notVip, lastOrderAt: { $lt: ago(now, 120) } },
        ],
      };
    case 'no_orders':
      return { $or: [{ ordersCount: 0 }, { ordersCount: null }], lastOrderAt: null };
    case 'returning':
      return { status: 'returning' };
    case 'one_order':
      return { ordersCount: 1 };
    case 'lapsed':
      return { lastOrderAt: { $ne: null, $lt: ago(now, lapsedDays()) } };
    case 'opted_in':
      return { optedInMarketing: true };
    default:
      return {};
  }
}

// The same rules for one customer record (for their profile).
function stageOf(c, now = new Date()) {
  const orders = Number(c.ordersCount) || 0;
  const last = c.lastOrderAt ? new Date(c.lastOrderAt).getTime() : null;
  if (!orders && !last) return 'no_orders';
  if (!orders || !last) return null;
  const days = (now.getTime() - last) / DAY;
  const vip = c.status === 'vip';
  if (days > 180) return 'lost';
  if (vip) return 'vip';
  if (orders === 1) return days <= 30 ? 'new' : days <= 120 ? 'second_order' : 'lost';
  return days <= 90 ? 'loyal' : 'at_risk';
}

function stageLabel(key) {
  const s = STAGES.find((x) => x.key === key);
  return s ? s.label : LEGACY[key] || '';
}

// ---------- Filters ----------
const ORDER_OPTIONS = { 1: { ordersCount: 1 }, '2+': { ordersCount: { $gte: 2 } }, '3+': { ordersCount: { $gte: 3 } }, '5+': { ordersCount: { $gte: 5 } } };
const SPENT_OPTIONS = [1000, 2500, 5000, 10000];
const LAST_ORDER_OPTIONS = ['30', '30-90', '90+', 'never'];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keeps only known filters with sensible values (they come from the page).
function cleanFilters(raw) {
  let f = raw;
  if (typeof f === 'string') {
    try {
      f = JSON.parse(f);
    } catch (err) {
      f = {};
    }
  }
  if (!f || typeof f !== 'object') return {};
  const out = {};
  const text = (v, max) => String(v || '').trim().slice(0, max);
  if (text(f.bought, 120)) out.bought = text(f.bought, 120);
  if (text(f.notBought, 120)) out.notBought = text(f.notBought, 120);
  if (ORDER_OPTIONS[f.orders]) out.orders = String(f.orders);
  if (SPENT_OPTIONS.includes(Number(f.minSpent))) out.minSpent = Number(f.minSpent);
  if (LAST_ORDER_OPTIONS.includes(f.lastOrder)) out.lastOrder = f.lastOrder;
  if (['online', 'cod'].includes(f.pays)) out.pays = f.pays;
  if (text(f.place, 40)) out.place = text(f.place, 40);
  if (text(f.tag, 30)) out.tag = text(f.tag, 30);
  if (['yes', 'no'].includes(f.offers)) out.offers = f.offers;
  if (f.birthday === 'month') out.birthday = 'month';
  return out;
}

function filterQuery(f, now) {
  const parts = [];
  if (f.bought) parts.push({ products: f.bought });
  if (f.notBought) parts.push({ products: { $ne: f.notBought } });
  if (f.orders) parts.push(ORDER_OPTIONS[f.orders]);
  if (f.minSpent) parts.push({ totalSpent: { $gte: f.minSpent } });
  if (f.lastOrder === '30') parts.push({ lastOrderAt: { $gte: ago(now, 30) } });
  if (f.lastOrder === '30-90') parts.push({ lastOrderAt: { $gte: ago(now, 90), $lt: ago(now, 30) } });
  if (f.lastOrder === '90+') parts.push({ lastOrderAt: { $lt: ago(now, 90) } });
  if (f.lastOrder === 'never') parts.push({ lastOrderAt: null });
  if (f.pays === 'online') parts.push({ prepaidOrders: { $gte: 1 }, $expr: { $gte: ['$prepaidOrders', '$codOrders'] } });
  if (f.pays === 'cod') parts.push({ codOrders: { $gte: 1 }, $expr: { $gt: ['$codOrders', '$prepaidOrders'] } });
  if (f.place) {
    const re = new RegExp(escapeRegex(f.place), 'i');
    parts.push({ $or: [{ city: re }, { state: re }, { pincode: re }] });
  }
  if (f.tag) parts.push({ tags: f.tag });
  if (f.offers === 'yes') parts.push({ optedInMarketing: true });
  if (f.offers === 'no') parts.push({ optedInMarketing: { $ne: true } });
  if (f.birthday === 'month') parts.push({ birthday: { $regex: `^${String(now.getMonth() + 1).padStart(2, '0')}-` } });
  return parts;
}

// Short words for a set of filters, e.g. "Bought Kaju Curry · ₹2,500+ spent".
function describeFilters(f = {}) {
  const out = [];
  if (f.bought) out.push(`Bought ${f.bought}`);
  if (f.notBought) out.push(`Never bought ${f.notBought}`);
  if (f.orders) out.push(f.orders === '1' ? '1 order' : `${f.orders} orders`);
  if (f.minSpent) out.push(`₹${f.minSpent.toLocaleString('en-IN')}+ spent`);
  if (f.lastOrder) out.push({ 30: 'Ordered in last 30 days', '30-90': 'Last order 30–90 days ago', '90+': 'Last order 90+ days ago', never: 'Never ordered' }[f.lastOrder]);
  if (f.pays) out.push(f.pays === 'cod' ? 'Mostly pays COD' : 'Mostly pays online');
  if (f.place) out.push(`In ${f.place}`);
  if (f.tag) out.push(`Tag: ${f.tag}`);
  if (f.offers) out.push(f.offers === 'yes' ? 'Gets offers' : "Doesn't get offers");
  if (f.birthday) out.push('Birthday this month');
  return out.join(' · ');
}

// Group + filters + optional search text, as one Mongo filter. (`tag` on its
// own is the older way of filtering by tag.)
function customerFilter({ segment = 'all', tag = '', q = '', filters = {} } = {}, now = new Date()) {
  const f = cleanFilters(filters);
  if (tag && !f.tag) f.tag = String(tag).slice(0, 30);
  const parts = [segmentQuery(segment, now), ...filterQuery(f, now)];
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

async function counts({ tag = '', filters = {} } = {}) {
  const out = {};
  await Promise.all(
    STAGES.map(async (s) => {
      out[s.key] = await Customer.countDocuments(customerFilter({ segment: s.key, tag, filters }));
    })
  );
  out.opted_in = await Customer.countDocuments(customerFilter({ segment: 'opted_in', tag, filters }));
  return out;
}

function isSegment(key) {
  return STAGES.some((s) => s.key === key) || Object.prototype.hasOwnProperty.call(LEGACY, key);
}

module.exports = {
  SEGMENTS,
  STAGES,
  segmentQuery,
  stageOf,
  stageLabel,
  cleanFilters,
  describeFilters,
  customerFilter,
  counts,
  isSegment,
  lapsedDays,
};
