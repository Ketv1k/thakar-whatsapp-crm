// Back-in-stock alerts. From a customer's profile the founder adds "tell them
// when X is back"; every half hour the app checks Shopify for those products
// and messages everyone waiting the moment one is available again.
const StockAlert = require('../models/StockAlert');
const Customer = require('../models/Customer');
const automations = require('./automations');
const templates = require('./templates');
const outbound = require('./outbound');
const shopify = require('./shopify');
const { isQuietTime } = require('../utils/time');

const DAY = 24 * 60 * 60 * 1000;
const EXPIRE_DAYS = 90;

// Pure: is what this alert waits for available now?
function isBack(alert, product) {
  if (!product || !product.active) return false;
  if (alert.variantId) {
    const v = product.variants.find((x) => x.id === alert.variantId);
    return !!(v && v.available);
  }
  // No size chosen: back as soon as any size can be bought.
  return (product.variants || []).some((v) => v.available);
}

async function sendAlert(alert, product, { now = new Date() } = {}) {
  const template = await templates.findByName('back_in_stock');
  if (!template || !templates.canSend(template)) return 'waiting';
  const claimed = await StockAlert.findOneAndUpdate(
    { _id: alert._id, status: 'waiting' },
    { $set: { status: 'sending', sentAt: now } },
    { new: true }
  );
  if (!claimed) return 'taken';
  const customer = await Customer.findOne({ phone: claimed.phone }).select('name').lean();
  const first = String(claimed.customerName || (customer && customer.name) || '').split(' ')[0] || 'there';
  const title = claimed.variantTitle ? `${claimed.productTitle} (${claimed.variantTitle})` : claimed.productTitle;
  const result = await outbound.sendTemplate({
    to: claimed.phone,
    template,
    bodyParams: [first, title, (product && product.url) || claimed.productUrl || shopify.storeUrl()],
    kind: 'back_in_stock',
  });
  if (outbound.shouldRetry(result, claimed.sendAttempts)) {
    await StockAlert.updateOne({ _id: claimed._id }, { $set: { status: 'waiting', sentAt: null, note: `Will try again: ${result.error}` }, $inc: { sendAttempts: 1 } });
    return 'retrying';
  }
  await StockAlert.updateOne(
    { _id: claimed._id },
    { $set: { status: result.ok ? 'sent' : 'failed', note: result.ok ? null : result.error } }
  );
  if (result.ok) await Customer.updateOne({ phone: claimed.phone }, { $set: { lastMarketingAt: now } });
  return result.ok ? 'sent' : 'failed';
}

async function run({ now = new Date() } = {}) {
  const automation = await automations.get('back_in_stock');
  if (!automation.enabled) return { skipped: 'off' };
  await StockAlert.updateMany(
    { status: 'waiting', createdAt: { $lt: new Date(now.getTime() - EXPIRE_DAYS * DAY) } },
    { $set: { status: 'expired', note: `No restock within ${EXPIRE_DAYS} days` } }
  );
  if (isQuietTime(now)) return { skipped: 'night' };
  if (!shopify.isConfigured()) return { skipped: 'Shopify not connected' };
  const productIds = await StockAlert.distinct('productId', { status: 'waiting', simulated: { $ne: true } });
  const tally = { products: productIds.length };
  for (let i = 0; i < productIds.length; i += 50) {
    const products = await shopify.productsByIds(productIds.slice(i, i + 50));
    const byId = new Map(products.map((p) => [p.id, p]));
    const alerts = await StockAlert.find({ status: 'waiting', productId: { $in: productIds.slice(i, i + 50) }, simulated: { $ne: true } });
    for (const alert of alerts) {
      const product = byId.get(alert.productId);
      if (!isBack(alert, product)) continue;
      const r = await sendAlert(alert, product, { now });
      tally[r] = (tally[r] || 0) + 1;
    }
  }
  return tally;
}

async function create({ phone, productId, variantId = null }) {
  const [product] = await shopify.productsByIds([productId]);
  if (!product) throw Object.assign(new Error('Product not found in Shopify'), { status: 404, expose: true });
  const variant = variantId ? product.variants.find((v) => v.id === variantId) : null;
  if (variantId && !variant) throw Object.assign(new Error('That size/pack was not found'), { status: 404, expose: true });
  const existing = await StockAlert.findOne({ phone, productId, variantId: variantId || null, status: 'waiting' });
  if (existing) return existing;
  const customer = await Customer.findOne({ phone }).select('name').lean();
  return StockAlert.create({
    phone,
    customerName: (customer && customer.name) || '',
    productId,
    productTitle: product.title,
    variantId: variantId || null,
    variantTitle: variant ? variant.title : '',
    productUrl: product.url,
  });
}

module.exports = { isBack, sendAlert, run, create, EXPIRE_DAYS };
