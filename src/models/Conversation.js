const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    customerPhone: { type: String, required: true, index: true },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    // Set once a ticket is opened against this conversation; cleared when resolved.
    activeTicketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    // "Needs a reply": the customer's latest message hasn't been answered by
    // the founder or by an automatic answer yet.
    unread: { type: Boolean, default: true },
    // When the customer last messaged. Free-form replies are only allowed for
    // 24 hours after this (WhatsApp's customer service window).
    lastInboundAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Conversation', conversationSchema);
