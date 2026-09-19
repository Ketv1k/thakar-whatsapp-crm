const mongoose = require('mongoose');
const Counter = require('./Counter');

const ticketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: Number, required: true, unique: true },
    customerPhone: { type: String, required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    orderNumber: { type: String, default: null },
    // 'delay' | 'damaged' | 'wrong_item' | 'missing' | 'refund_request' | 'other'
    issueType: { type: String, required: true },
    // 'open' -> founder hasn't replied yet
    // 'founder_replied' -> founder has responded, waiting on customer / closing
    // 'resolved' -> closed
    status: { type: String, enum: ['open', 'founder_replied', 'resolved'], default: 'open', index: true },
    lastActivityAt: { type: Date, default: Date.now },
    reminderSentAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Auto-incrementing ticket number. Uses an atomic counter ($inc) rather than
// "read the max and add one" so two webhook messages arriving at the same
// instant can't be handed the same number and collide on the unique index.
// Numbering starts at 1001.
ticketSchema.statics.nextTicketNumber = async function () {
  return Counter.next('ticketNumber', 1000);
};

module.exports = mongoose.model('Ticket', ticketSchema);
