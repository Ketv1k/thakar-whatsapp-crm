// Copies every Shopify customer with a phone number into the CRM, with their
// order count, spend, last order date and city - what the Customers page and
// campaign groups are built from. Checkpointed like the order sync, so after
// the first full import it only fetches customers who changed.
const Customer = require('../models/Customer');
const shopify = require('./shopify');
const settings = require('./settings');
const customerStatus = require('./customerStatus');
const consent = require('./consent');
const { normalizePhone } = require('../utils/phone');

const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 60;
// Bumped when new fields are read, so every customer is fetched once more.
const SYNC_VERSION = 3;

const CUSTOMER_FIELDS = `
  id displayName phone numberOfOrders updatedAt tags note
  amountSpent { amount currencyCode }
  lastOrder { createdAt }
  defaultAddress { city province zip phone }
  smsMarketingConsent { marketingState }
  defaultPhoneNumber { whatsAppMarketingConsent { state updatedAt } }
`;
const MAX_TAGS = 50;

// Shopify's tags as they are (no re-casing, so they match Shopify exactly).
function remoteTags(tags) {
  const seen = new Set();
  return (tags || [])
    .map((t) => String(t).trim().slice(0, 40))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_TAGS);
}

// Pure: what the customer's tags and note become when Shopify's copy
// arrives. Shopify wins, except:
//  - changes made here that haven't reached Shopify yet are kept;
//  - the first time, anything written here that Shopify doesn't have is kept
//    and sent to Shopify, so nothing typed in the app is lost.
function mergeFromShopify(existing, shopifyTags, shopifyNote, now = new Date()) {
  const tags = remoteTags(shopifyTags);
  const note = String(shopifyNote || '');
  if (existing && existing.shopifyPush) return {};
  if (existing && !existing.tagsPulledAt && ((existing.tags || []).length || String(existing.notes || '').trim())) {
    const missing = (existing.tags || []).filter((t) => !tags.some((r) => r.toLowerCase() === String(t).toLowerCase()));
    const mine = String(existing.notes || '').trim();
    const pushNote = mine && mine !== note.trim() ? (note.trim() ? `${note.trim()}\n${mine}` : mine) : null;
    const out = { tags: [...tags, ...missing].slice(0, MAX_TAGS), notes: pushNote != null ? pushNote : note, tagsPulledAt: now };
    if (missing.length || pushNote != null) out.shopifyPush = { tagsAdd: missing, tagsRemove: [], note: pushNote, v: 1 };
    return out;
  }
  return { tags, notes: note, tagsPulledAt: now };
}

// Shopify customer -> our fields. Pure. null when there's no usable phone.
function mapCustomer(node) {
  const phone = normalizePhone(node.phone) || normalizePhone(node.defaultAddress?.phone);
  if (!phone) return null;
  const ordersCount = Number(node.numberOfOrders || 0);
  const totalSpent = Number(node.amountSpent?.amount || 0);
  return {
    phone,
    name: (node.displayName || '').trim(),
    fields: {
      shopifyCustomerId: node.id,
      city: node.defaultAddress?.city || '',
      state: node.defaultAddress?.province || '',
      pincode: node.defaultAddress?.zip || '',
      ordersCount,
      totalSpent,
      currency: node.amountSpent?.currencyCode || 'INR',
      lastOrderAt: node.lastOrder?.createdAt ? new Date(node.lastOrder.createdAt) : null,
      status: customerStatus.classify(ordersCount, totalSpent),
      marketingConsent: node.smsMarketingConsent?.marketingState || null,
      shopifyUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
    },
    shopifyTags: Array.isArray(node.tags) ? node.tags : null,
    shopifyNote: node.note || '',
    // Shopify's own record of WhatsApp marketing consent (not SMS).
    whatsAppConsent: node.defaultPhoneNumber?.whatsAppMarketingConsent
      ? { state: node.defaultPhoneNumber.whatsAppMarketingConsent.state, updatedAt: node.defaultPhoneNumber.whatsAppMarketingConsent.updatedAt || null }
      : null,
  };
}

async function optInFromShopifyEnabled() {
  const s = await settings.get('optin:shopify', {});
  return !!s.enabled;
}

// Pure: what Shopify's WhatsApp marketing consent changes here. SUBSCRIBED
// opts them in (unless they said STOP here more recently); UNSUBSCRIBED
// in Shopify after they opted in here opts them out. SMS consent is never
// used for WhatsApp.
function consentFromShopify(existing, waConsent) {
  if (!waConsent || !waConsent.state) return {};
  const at = waConsent.updatedAt ? new Date(waConsent.updatedAt) : new Date();
  const e = existing || {};
  if (waConsent.state === 'SUBSCRIBED') {
    if (e.optedInMarketing) return { shopifyWaConsent: 'SUBSCRIBED' };
    if (e.optedOutAt && new Date(e.optedOutAt) >= at) return {};
    return {
      ...consent.optInFields({ source: 'shopify_whatsapp', evidence: `Agreed to WhatsApp marketing in Shopify (${consent.stamp(at)})`, at }),
      shopifyWaConsent: 'SUBSCRIBED',
    };
  }
  if (waConsent.state === 'UNSUBSCRIBED' && e.optedInMarketing && (!e.optedInAt || new Date(e.optedInAt) < at)) {
    return { optedInMarketing: false, optInSource: null, optedOutAt: at, shopifyWaConsent: 'UNSUBSCRIBED' };
  }
  return {};
}

async function saveCustomer(mapped) {
  const existing = await Customer.findOne({ phone: mapped.phone })
    .select('name optedInMarketing optedInAt optedOutAt tags notes tagsPulledAt shopifyPush')
    .lean();
  const $set = { ...mapped.fields };
  if (mapped.shopifyTags) Object.assign($set, mergeFromShopify(existing, mapped.shopifyTags, mapped.shopifyNote));
  Object.assign($set, consentFromShopify(existing, mapped.whatsAppConsent));
  // Shopify's name is the real one; the WhatsApp profile name can be a nickname.
  if (mapped.name && (!existing || !existing.name || existing.name === mapped.phone)) $set.name = mapped.name;
  await Customer.updateOne({ phone: mapped.phone }, { $set, $setOnInsert: { phone: mapped.phone } }, { upsert: true });
}

// One customer, fresh from Shopify (for instant updates).
async function syncOne(gid) {
  const data = await shopify.graphql(`query One($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`, { id: gid });
  const mapped = data.customer ? mapCustomer(data.customer) : null;
  if (!mapped) return null;
  await saveCustomer(mapped);
  return mapped.phone;
}

async function syncCustomers() {
  if (!shopify.isConfigured()) return { skipped: 'Shopify not connected' };
  const state = await settings.get('sync:customers', {});
  const upgrading = state.version !== SYNC_VERSION;
  let checkpoint = !upgrading && state.checkpoint ? new Date(state.checkpoint) : null;
  const query = checkpoint ? `updated_at:>'${new Date(checkpoint.getTime() - 2 * 60 * 1000).toISOString()}'` : '';
  // SMS consent used to be allowed to count as WhatsApp consent; it no longer
  // does. If that switch was on, undo the opt-ins it made.
  if (await optInFromShopifyEnabled()) await setOptInFromShopify(false);
  let after = state.cursor && !checkpoint ? state.cursor : null;
  let fetched = 0;
  let saved = 0;
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await shopify.graphql(
        `query Customers($q: String, $after: String) {
          customers(first: ${PAGE_SIZE}, after: $after, sortKey: UPDATED_AT, query: $q) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              ${CUSTOMER_FIELDS}
            } }
          }
        }`,
        { q: query || null, after },
        { timeout: 30000 }
      );
      const conn = data.customers;
      let newest = checkpoint;
      for (const edge of conn.edges) {
        fetched++;
        const mapped = mapCustomer(edge.node);
        if (mapped) {
          await saveCustomer(mapped);
          saved++;
        }
        const updatedAt = new Date(edge.node.updatedAt);
        if (!newest || updatedAt > newest) newest = updatedAt;
      }
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      if (checkpoint) {
        checkpoint = newest;
        await settings.merge('sync:customers', { checkpoint });
      } else {
        // First full import: remember the page, and the newest change seen so
        // the next runs only ask for what changed after it.
        await settings.merge('sync:customers', { cursor: after, pendingCheckpoint: newest });
        if (!after) await settings.merge('sync:customers', { checkpoint: newest || new Date(), cursor: null, version: SYNC_VERSION });
      }
      if (!after) break;
    }
    const total = await Customer.countDocuments({ shopifyCustomerId: { $ne: null } });
    await settings.merge('sync:customers', { lastRunAt: new Date(), lastError: null, total });
    return { fetched, saved, total, complete: !after };
  } catch (err) {
    await settings.merge('sync:customers', { lastRunAt: new Date(), lastError: err.message.slice(0, 300) });
    throw err;
  }
}

// The old "count Shopify's (SMS) marketing consent" switch. SMS consent
// isn't permission for WhatsApp, so it can only be turned off, which undoes
// the opt-ins it made. WhatsApp consent recorded in Shopify is used instead
// (consentFromShopify).
async function setOptInFromShopify(enabled) {
  if (enabled) {
    throw Object.assign(new Error("Shopify's SMS marketing consent isn't permission for WhatsApp, so it can't be used for offers."), { status: 400, expose: true });
  }
  await settings.set('optin:shopify', { enabled: false, changedAt: new Date() });
  const res = await Customer.updateMany(
    { optInSource: 'shopify' },
    { $set: { optedInMarketing: false, optInSource: null, optedInAt: null } }
  );
  return { changed: res.modifiedCount };
}

module.exports = { mapCustomer, mergeFromShopify, consentFromShopify, syncCustomers, syncOne, setOptInFromShopify, optInFromShopifyEnabled };
