const mongoose = require('mongoose');

// Carts people left at checkout (from Shopify), and whether a WhatsApp
// reminder went out and led to an order.
const abandonedCheckoutSchema = new mongoose.Schema(
  {
    shopifyId: { type: String, required: true, unique: true },
    phone: { type: String, default: null, index: true },
    firstName: { type: String, default: '' },
    // The link sent to the customer (see cartRecovery.mapCheckout).
    url: String,
    // 'magic' (reopens Razorpay Magic Checkout) | 'cart' (cart page with the
    // items) | 'shopify' (Shopify's own checkout)
    linkType: { type: String, default: null },
    shopifyUrl: String,
    // What the customer chose for WhatsApp messages at checkout (Magic
    // Checkout records it): true / false / null when not asked.
    whatsappConsent: { type: Boolean, default: null },
    // Where they stopped, e.g. "Payment Attempted" (from Magic Checkout).
    dropOffStep: { type: String, default: null },
    total: Number,
    currency: { type: String, default: 'INR' },
    items: [String],
    checkoutCreatedAt: { type: Date, index: true },
    completedAt: { type: Date, default: null },
    simulated: { type: Boolean, default: false },
    remindedAt: { type: Date, default: null, index: true },
    // 'sent' | 'skipped' | 'failed'
    remindStatus: { type: String, default: null },
    sendAttempts: { type: Number, default: 0 },
    skipReason: { type: String, default: null },
    recoveredAt: { type: Date, default: null },
    recoveredOrderName: { type: String, default: null },
    recoveredTotal: { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AbandonedCheckout', abandonedCheckoutSchema);
