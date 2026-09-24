const mongoose = require('mongoose');
const Counter = require('./Counter');

const ticketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: Number, required: true, unique: true },
    customerPhone: { type: String, required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    orderNumber: { type: String, default: null },
    // 'delay' | 'damaged' | 'wrong_item' | 'missing' | 'payment' | 'refund_request' | 'quality' | 'other'
    issueType: { type: String, required: true },
    // 'open' -> founder hasn't replied yet
    // 'founder_replied' -> founder has responded, waiting on customer / closing
    // 'resolved' -> closed
    status: { type: String, enum: ['open', 'founder_replied', 'resolved'], default: 'open', index: true },
    lastActivityAt: { type: Date, default: Date.now },
    reminderSentAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null }, // team member's name
  },
  { timestamps: true }
);

// Auto-incrementing ticket number. Uses an atomic counter ($inc) rather than
// "read the max and add one" so two webhook messages arriving at the same
// instant can't be handed the same number and collide on the unique index.
// Numbering starts at 1001 on a fresh database.
ticketSchema.statics.nextTicketNumber = async function () {
  // First time only: seed the counter from the highest existing ticket number,
  // so deploying over a database that already has tickets (e.g. from the old
  // max-plus-one scheme) doesn't hand out numbers that are already taken.
  const existing = await Counter.findById('ticketNumber').lean();
  if (!existing) {
    const last = await this.findOne().sort({ ticketNumber: -1 }).select('ticketNumber').lean();
    const seed = last ? last.ticketNumber : 1000;
    await Counter.updateOne(
      { _id: 'ticketNumber' },
      { $setOnInsert: { seq: seed } },
      { upsert: true }
    );
  }
  return Counter.next('ticketNumber');
};

module.exports = mongoose.model('Ticket', ticketSchema);
