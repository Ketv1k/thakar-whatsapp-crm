const mongoose = require('mongoose');

// A phone or computer that asked for notifications, for one person.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: String, auth: String },
    userId: { type: String, required: true, index: true }, // 'owner' for the access code
    userName: { type: String, default: '' },
    device: { type: String, default: '' },
    lastSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
