// Only mounted when TEST_MODE=true. Lets the founder try the whole support flow
// before WhatsApp is connected: "send" a message as any customer and see what
// the real pipeline does with it. Outgoing replies are never sent in test mode.
const crypto = require('crypto');
const express = require('express');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const shopify = require('../services/shopify');
const { handleIncomingMessage } = require('./webhook');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const PHONE_RE = /^[0-9]{8,15}$/;

// Real Shopify customers to pretend to be. Empty list if Shopify is unreachable,
// so the founder can still type a number by hand.
router.get('/customers', asyncHandler(async (req, res) => {
  try {
    res.json(await shopify.listRecentCustomersWithPhone(15));
  } catch (err) {
    console.error('[test mode] could not load Shopify customers', err.message);
    res.json([]);
  }
}));

router.post('/simulate', asyncHandler(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const name = String(req.body.name || '').trim().slice(0, 80);
  const type = req.body.type === 'image' ? 'image' : 'text';
  const text = String(req.body.text || '').trim().slice(0, 1000);

  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Enter a phone number with country code, e.g. 919876543210' });
  }
  if (type === 'text' && !text) return res.status(400).json({ error: 'Type a message first' });

  const before = await Conversation.findOne({ customerPhone: phone }).lean();
  const startedAt = new Date();

  // Same shape Meta sends, run through the exact same handler as a real webhook.
  await handleIncomingMessage(
    {
      from: phone,
      id: `wamid.TEST.${crypto.randomUUID()}`,
      type,
      ...(type === 'text' ? { text: { body: text } } : { image: { id: 'test-image' } }),
    },
    { contacts: [{ profile: { name } }] }
  );

  const after = await Conversation.findOne({ customerPhone: phone }).lean();
  const replies = after
    ? await Message.find({ conversationId: after._id, direction: 'outbound', createdAt: { $gte: startedAt } })
        .sort({ createdAt: 1 })
        .lean()
    : [];
  const ticket = after?.activeTicketId ? await Ticket.findById(after.activeTicketId).lean() : null;

  let outcome = 'chat';
  if (ticket && before?.activeTicketId && String(before.activeTicketId) === String(ticket._id)) {
    outcome = 'added_to_ticket';
  } else if (ticket) {
    outcome = 'ticket_created';
  } else if (replies.length) {
    outcome = 'auto_answered';
  }

  res.json({
    outcome,
    conversationId: after?._id || null,
    ticketId: ticket?._id || null,
    ticketNumber: ticket?.ticketNumber || null,
    issueType: ticket?.issueType || null,
    replies: replies.map((r) => r.body),
  });
}));

module.exports = router;
