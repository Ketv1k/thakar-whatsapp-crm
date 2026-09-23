// The founder's reply from the inbox, whether the chat has a ticket or not.
// Sends it on WhatsApp, records it with delivery tracking, and moves the
// ticket (if any) to "You replied".
const Ticket = require('../models/Ticket');
const outbound = require('./outbound');
const replyWindow = require('./replyWindow');

class ReplyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

async function replyAsFounder({ conversation, body, ticket = null }) {
  const text = String(body || '').trim();
  if (!text) throw new ReplyError(400, 'Type a reply first');
  if (text.length > 4096) throw new ReplyError(400, 'That reply is too long for WhatsApp (4,096 characters max)');

  // WhatsApp rejects free-form messages once 24h have passed since the
  // customer's last message - say so plainly instead of failing silently.
  if (!replyWindow.isWindowOpen(conversation.lastInboundAt)) {
    throw new ReplyError(
      409,
      "The 24-hour reply window has closed. WhatsApp only lets you message this customer again after they message you."
    );
  }

  if (!ticket && conversation.activeTicketId) {
    ticket = await Ticket.findById(conversation.activeTicketId);
  }

  const message = await outbound.sendText({
    conversationId: conversation._id,
    ticketId: ticket ? ticket._id : null,
    to: conversation.customerPhone,
    body: text,
    sentByFounder: true,
  });

  if (ticket) {
    const wasResolved = ticket.status === 'resolved';
    ticket.status = 'founder_replied';
    ticket.lastActivityAt = new Date();
    if (wasResolved) ticket.resolvedAt = null;
    await ticket.save();
    // Replying reopens a resolved ticket: restore it on the conversation so
    // the customer's next message attaches to it instead of new triage.
    conversation.activeTicketId = ticket._id;
  }

  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = text.slice(0, 140);
  conversation.unread = false;
  await conversation.save();

  return message;
}

module.exports = { replyAsFounder, ReplyError };
