const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    // WhatsApp phone number, digits only with country code, e.g. "919876543210"
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    // Cached from Shopify so we don't hit their API on every message
    shopifyCustomerId: { type: String, default: null },
    lastOrderNumber: { type: String, default: null },
    optedInMarketing: { type: Boolean, default: false },
    // Founder's private note about this customer (allergies, preferences, etc.).
    notes: { type: String, default: '' },
    // Founder's own labels ("Jain", "Monthly", "Gifting") for finding and
    // grouping customers. Cleaned by services/tags.js.
    tags: { type: [String], default: [], index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Customer', customerSchema);
