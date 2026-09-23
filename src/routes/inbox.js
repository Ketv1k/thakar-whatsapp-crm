const express = require('express');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const whatsapp = require('../services/whatsapp');
const { asyncHandler } = require('../utils/asyncHandler');
const { attachCustomerNames } = require('../utils/customerNames');

const router = express.Router();

// Small config the Founder Inbox reads once (e.g. to flag tickets past SLA).
router.get('/config', (req, res) => {
  res.json({ slaHours: Number(process.env.SLA_HOURS || 6) });
});

// General chats only - anything with an active ticket lives in the Tickets tab instead,
// so nothing shows up twice.
router.get('/conversations', asyncHandler(async (req, res) => {
  const conversations = await Conversation.find({ activeTicketId: null })
    .sort({ lastMessageAt: -1 })
    .limit(100)
    .lean();
  await attachCustomerNames(conversations);
  res.json(conversations);
}));

router.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const messages = await Message.find({ conversationId: req.params.id }).sort({ createdAt: 1 }).lean();
  res.json(messages);
}));

router.post('/conversations/:id/reply', asyncHandler(async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });

  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'conversation not found' });

  await whatsapp.sendTextMessage(conversation.customerPhone, body);
  const message = await Message.create({
    conversationId: conversation._id,
    direction: 'outbound',
    type: 'text',
    body,
    sentByFounder: true,
  });

  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = body.slice(0, 140);
  conversation.unread = false;
  await conversation.save();

  res.json(message);
}));

// Manual safety net: turn any general chat into a ticket, in case the
// keyword triage missed something.
router.post('/conversations/:id/flag-ticket', asyncHandler(async (req, res) => {
  const { issueType = 'other' } = req.body;
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'conversation not found' });
  if (conversation.activeTicketId) return res.status(400).json({ error: 'conversation already has an open ticket' });

  const ticketNumber = await Ticket.nextTicketNumber();
  const ticket = await Ticket.create({
    ticketNumber,
    customerPhone: conversation.customerPhone,
    conversationId: conversation._id,
    issueType,
    status: 'open',
    lastActivityAt: new Date(),
  });

  conversation.activeTicketId = ticket._id;
  await conversation.save();

  res.json(ticket);
}));

module.exports = router;
