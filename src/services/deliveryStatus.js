// Delivery ticks for messages we send. WhatsApp reports each outgoing message
// as sent -> delivered -> read (or failed) through the webhook's `statuses`
// list. Updates can arrive out of order, so a status only ever moves forward:
// a late "delivered" never downgrades a message that is already "read".
const Message = require('../models/Message');

const PROGRESS = ['sent', 'delivered', 'read'];

/**
 * The Mongo filter + update for one webhook status entry, or null when the
 * entry isn't something we track. Pure, so it can be unit tested.
 */
function statusChange(entry) {
  const id = entry && entry.id;
  const status = entry && entry.status;
  if (!id || typeof id !== 'string') return null;

  const at = entry.timestamp ? new Date(Number(entry.timestamp) * 1000) : new Date();
  const statusAt = Number.isNaN(at.getTime()) ? new Date() : at;

  if (status === 'failed') {
    const err = (entry.errors && entry.errors[0]) || {};
    const reason = String(err.error_data?.details || err.title || err.message || 'Not delivered').slice(0, 300);
    return {
      filter: { waMessageId: id, direction: 'outbound', status: { $ne: 'read' } },
      update: { $set: { status: 'failed', statusAt, statusError: reason } },
    };
  }

  const rank = PROGRESS.indexOf(status);
  if (rank === -1) return null;
  const earlier = [null, ...PROGRESS.slice(0, rank), 'failed'];
  return {
    filter: { waMessageId: id, direction: 'outbound', status: { $in: earlier } },
    update: { $set: { status, statusAt }, $unset: { statusError: '' } },
  };
}

async function applyStatus(entry) {
  const change = statusChange(entry);
  if (!change) return false;
  const res = await Message.updateOne(change.filter, change.update);
  return res.modifiedCount > 0;
}

module.exports = { statusChange, applyStatus, PROGRESS };
