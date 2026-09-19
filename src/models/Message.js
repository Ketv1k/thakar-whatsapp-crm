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

module.exports = mongoose.model('Message', messageSchema);
