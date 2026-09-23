// WhatsApp's customer service window: after a customer messages you, you can
// reply freely (and for free) for 24 hours. After that only pre-approved
// templates can be sent until they message again.
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const WINDOW_MS = 24 * 60 * 60 * 1000;

function windowClosesAt(lastInboundAt) {
  if (!lastInboundAt) return null;
  const t = new Date(lastInboundAt).getTime();
  return Number.isNaN(t) ? null : new Date(t + WINDOW_MS);
}

function isWindowOpen(lastInboundAt, now = Date.now()) {
  const closes = windowClosesAt(lastInboundAt);
  return !!closes && closes.getTime() > now;
}

// Conversations saved before lastInboundAt existed: fill it in once from their
// messages. Mutates the given (lean) conversations and saves the value.
async function backfillLastInbound(conversations) {
  const missing = conversations.filter((c) => !c.lastInboundAt);
  if (missing.length === 0) return conversations;
  const rows = await Message.aggregate([
    { $match: { conversationId: { $in: missing.map((c) => c._id) }, direction: 'inbound' } },
    { $group: { _id: '$conversationId', at: { $max: '$createdAt' } } },
  ]);
  const byId = new Map(rows.map((r) => [String(r._id), r.at]));
  await Promise.all(
    missing.map((c) => {
      const at = byId.get(String(c._id));
      if (!at) return null;
      c.lastInboundAt = at;
      return Conversation.updateOne({ _id: c._id, lastInboundAt: null }, { $set: { lastInboundAt: at } });
    })
  );
  return conversations;
}

module.exports = { windowClosesAt, isWindowOpen, backfillLastInbound, WINDOW_MS };
