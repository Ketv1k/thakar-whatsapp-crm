const express = require('express');
const Ticket = require('../models/Ticket');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { replyAsFounder } = require('../services/founderReply');
const { asyncHandler } = require('../utils/asyncHandler');
const { attachCustomerNames } = require('../utils/customerNames');

const router = express.Router();

const VALID_STATUSES = ['open', 'founder_replied', 'resolved'];

// Default view: everything that still needs attention. ?status=resolved to see history.
router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status;
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid status filter' });
  }
  const filter = status ? { status } : { status: { $in: ['open', 'founder_replied'] } };
  const tickets = await Ticket.find(filter).sort({ lastActivityAt: -1 }).limit(200).lean();
  await attachCustomerNames(tickets);
  res.json(tickets);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).lean();
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  await attachCustomerNames([ticket]);
  const messages = await Message.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).lean();
  res.json({ ticket, messages });
}));

router.post('/:id/reply', asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  const conversation = await Conversation.findById(ticket.conversationId);
  if (!conversation) return res.status(404).json({ error: 'conversation not found' });
  res.json(await replyAsFounder({ conversation, body: req.body.body, ticket }));
}));

router.post('/:id/resolve', asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });

  ticket.status = 'resolved';
  ticket.resolvedAt = new Date();
  await ticket.save();

  // Free up the conversation so future messages go back to normal triage
  // instead of silently attaching to a closed ticket.
  await Conversation.findByIdAndUpdate(ticket.conversationId, { activeTicketId: null });

  res.json(ticket);
}));

module.exports = router;
