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
  },
  { timestamps: true }
);

// Idempotency guard: Meta retries webhook deliveries aggressively, so the same
// inbound message can arrive more than once. A unique index on the WhatsApp
// message id lets a duplicate insert fail fast (code 11000) instead of creating
// a second copy. Sparse so our outbound messages (waMessageId: null) are exempt.
messageSchema.index({ waMessageId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Message', messageSchema);
