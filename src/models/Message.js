const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null, index: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    // 'text' | 'image' | 'template' | 'interactive' | 'system'
    type: { type: String, default: 'text' },
    body: { type: String, default: '' },
    mediaUrl: { type: String, default: null },
    waMessageId: { type: String, default: null },
    sentByFounder: { type: Boolean, default: false },
    // Set on messages the app sent by itself: 'order_status', 'ticket', or an
    // acknowledgment category from services/autoAck.js ('greeting', 'photo'...).
    autoAck: { type: String, default: null },
  },
  { timestamps: true }
);

// Idempotency guard: Meta retries webhook deliveries aggressively, so the same
// inbound message can arrive more than once. A unique index on the WhatsApp
// message id lets a duplicate insert fail fast (code 11000) instead of creating
// a second copy. A *partial* index (only rows where waMessageId is a string) is
// required rather than `sparse`: outbound messages store waMessageId as an
// explicit null, which a sparse index still treats as an indexed value and would
// reject as a duplicate on the second outbound message.
messageSchema.index(
  { waMessageId: 1 },
  { unique: true, partialFilterExpression: { waMessageId: { $type: 'string' } } }
);

module.exports = mongoose.model('Message', messageSchema);
