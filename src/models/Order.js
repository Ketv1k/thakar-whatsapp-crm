const mongoose = require('mongoose');

// A copy of each Shopify order the automations care about, kept up to date by
// the order sync (services/orderSync.js). Holds what was already sent for the
// order, so every WhatsApp update goes out at most once.
const itemSchema = new mongoose.Schema(
  { title: String, quantity: Number, productId: String, handle: String, url: String },
  { _id: false }
);

const fulfillmentSchema = new mongoose.Schema(
  {
    id: String,
    createdAt: Date,
    updatedAt: Date,
    displayStatus: String,
    deliveredAt: Date,
    trackingUrl: String,
    trackingNumber: String,
    trackingCompany: String,
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    shopifyId: { type: String, required: true, unique: true },
    name: { type: String, default: '' }, // "#3451"
    phone: { type: String, default: null, index: true },
    customerName: { type: String, default: '' },
    firstName: { type: String, default: '' },
    shopifyCustomerId: { type: String, default: null },
    placedAt: { type: Date, index: true },
    shopifyUpdatedAt: Date,
    cancelledAt: { type: Date, default: null },
    shopifyTest: { type: Boolean, default: false },
    // Made by test mode's "place a test order" - never exists in Shopify.
    simulated: { type: Boolean, default: false },
    total: { type: Number, default: 0 },
    outstanding: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    financialStatus: String,
    fulfillmentStatus: String,
    gateways: [String],
    tags: [String],
    isCod: { type: Boolean, default: false, index: true },
    statusPageUrl: String,
    // Set when the order came from a cart link sent in a chat (services/cartLinks.js).
    waCartId: { type: String, default: null, index: true },
    items: [itemSchema],
    fulfillments: [fulfillmentSchema],
    shippedAt: { type: Date, default: null },
    outForDeliveryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cod: {
      // none: not asked · awaiting: asked, no answer yet · confirmed · cancel_requested
      status: { type: String, enum: ['none', 'awaiting', 'confirmed', 'cancel_requested'], default: 'none' },
      requestedAt: Date,
      answeredAt: Date,
      answeredBy: String, // 'customer' | 'founder'
    },
    // When each WhatsApp update was sent (or deliberately skipped) for this order.
    notified: {
      confirmed: Date,
      cod_request: Date,
      shipped: Date,
      out_for_delivery: Date,
      delivered: Date,
      reorder: Date,
    },
    // Why an update was skipped or failed, per event, for the Automations page.
    notifyNotes: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Failed tries per update, so temporary WhatsApp problems are retried a few times.
    sendAttempts: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

orderSchema.index({ isCod: 1, 'cod.status': 1 });
orderSchema.index({ shippedAt: 1 });

module.exports = mongoose.model('Order', orderSchema);
