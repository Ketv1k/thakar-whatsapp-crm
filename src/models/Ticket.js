const mongoose = require('mongoose');

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

// Simple auto-incrementing ticket number without needing a separate counter collection library.
ticketSchema.statics.nextTicketNumber = async function () {
  const last = await this.findOne().sort({ ticketNumber: -1 }).select('ticketNumber').lean();
  return last ? last.ticketNumber + 1 : 1001;
};

module.exports = mongoose.model('Ticket', ticketSchema);
