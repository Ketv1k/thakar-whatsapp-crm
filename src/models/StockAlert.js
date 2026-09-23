const mongoose = require('mongoose');

// "Tell me when it's back": a customer waiting for a sold-out product.
const stockAlertSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    customerName: { type: String, default: '' },
    productId: { type: String, required: true, index: true },
    productTitle: { type: String, default: '' },
    // Set when one size/pack is sold out; empty means the whole product.
    variantId: { type: String, default: null },
    variantTitle: { type: String, default: '' },
    productUrl: { type: String, default: '' },
    // 'waiting' | 'sent' | 'cancelled' | 'failed' | 'expired'
    status: { type: String, default: 'waiting', index: true },
    sentAt: { type: Date, default: null },
    note: { type: String, default: null },
    simulated: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StockAlert', stockAlertSchema);
