const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    customerPhone: { type: String, required: true, index: true },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    // Set once a ticket is opened against this conversation; cleared when resolved.
    activeTicketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    unread: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Conversation', conversationSchema);
