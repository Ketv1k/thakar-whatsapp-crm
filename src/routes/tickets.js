const express = require('express');
const Ticket = require('../models/Ticket');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const whatsapp = require('../services/whatsapp');

const router = express.Router();

// Default view: everything that still needs attention. ?status=resolved to see history.
router.get('/', async (req, res) => {
  const status = req.query.status;
  const filter = status ? { status } : { status: { $in: ['open', 'founder_replied'] } };
  const tickets = await Ticket.find(filter).sort({ lastActivityAt: -1 }).limit(200).lean();
  res.json(tickets);
});

router.get('/:id', async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).lean();
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  const messages = await Message.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).lean();
  res.json({ ticket, messages });
});

router.post('/:id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });

  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });

  await whatsapp.sendTextMessage(ticket.customerPhone, body);
  const message = await Message.create({
    conversationId: ticket.conversationId,
    ticketId: ticket._id,
    direction: 'outbound',
    type: 'text',
    body,
    sentByFounder: true,
  });

  ticket.status = 'founder_replied';
  ticket.lastActivityAt = new Date();
  await ticket.save();

  await Conversation.findByIdAndUpdate(ticket.conversationId, {
    lastMessageAt: new Date(),
    lastMessagePreview: body.slice(0, 140),
  });

  res.json(message);
});

router.post('/:id/resolve', async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });

  ticket.status = 'resolved';
  ticket.resolvedAt = new Date();
  await ticket.save();

  // Free up the conversation so future messages go back to normal triage
  // instead of silently attaching to a closed ticket.
  await Conversation.findByIdAndUpdate(ticket.conversationId, { activeTicketId: null });

  res.json(ticket);
});

module.exports = router;
