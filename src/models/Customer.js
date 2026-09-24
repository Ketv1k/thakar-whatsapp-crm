const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    // WhatsApp phone number, digits only with country code, e.g. "919876543210"
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    // Cached from Shopify so we don't hit their API on every message
    shopifyCustomerId: { type: String, default: null },
    lastOrderNumber: { type: String, default: null },
    // May receive marketing (campaigns, cart/reorder reminders). Set by the
    // founder, by the customer replying START, by bulk opt-in, or from
    // Shopify's marketing consent when that option is on. STOP clears it.
    optedInMarketing: { type: Boolean, default: false, index: true },
    optInSource: { type: String, default: null }, // 'manual' | 'keyword' | 'bulk' | 'shopify' | 'import' | 'checkout'
    optedInAt: { type: Date, default: null },
    optedOutAt: { type: Date, default: null },
    // Last marketing message sent, so campaigns don't pile up on one person.
    lastMarketingAt: { type: Date, default: null },
    // From the Shopify sync (services/customerSync.js).
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    ordersCount: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    lastOrderAt: { type: Date, default: null, index: true },
    // 'new' | 'returning' | 'vip' (services/customerStatus.js)
    status: { type: String, default: 'new', index: true },
    // Shopify's SMS marketing consent: 'SUBSCRIBED' | 'NOT_SUBSCRIBED' | ...
    marketingConsent: { type: String, default: null },
    shopifyUpdatedAt: { type: Date, default: null },
    // Founder's private note about this customer (allergies, preferences, etc.).
    notes: { type: String, default: '' },
    // Founder's own labels ("Jain", "Monthly", "Gifting") for finding and
    // grouping customers. Cleaned by services/tags.js.
    tags: { type: [String], default: [], index: true },
    // Worked out from their orders (services/customerInsights.js).
    products: { type: [String], default: [], index: true }, // everything they've bought
    favourites: { type: [String], default: [] }, // what they buy most, top 3
    firstOrderAt: { type: Date, default: null },
    avgGapDays: { type: Number, default: null }, // usual days between orders
    codOrders: { type: Number, default: 0 },
    prepaidOrders: { type: Number, default: 0 },
    codCancelled: { type: Number, default: 0 }, // COD orders that were cancelled
    // Founder's reminder to get back to this customer, shown on Home when due.
    followUpAt: { type: Date, default: null, index: true },
    followUpNote: { type: String, default: '' },
    birthday: { type: String, default: '' }, // 'MM-DD'
  },
  { timestamps: true }
);

module.exports = mongoose.model('Customer', customerSchema);
