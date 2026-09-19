const express = require('express');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const whatsapp = require('../services/whatsapp');
const shopify = require('../services/shopify');
const triage = require('../services/ticketTriage');

const router = express.Router();

// ---- Webhook verification (Meta calls this once, when you set up the webhook URL) ----
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- Incoming messages & status updates ----
router.post('/', async (req, res) => {
  // Always ack fast - Meta retries aggressively if you don't respond quickly.
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return; // e.g. a delivery/read status update, nothing to do

    for (const waMessage of messages) {
      await handleIncomingMessage(waMessage, value);
    }
  } catch (err) {
    console.error('[webhook] error handling incoming message', err);
  }
});

async function handleIncomingMessage(waMessage, value) {
  const fromPhone = waMessage.from; // digits only, e.g. "919876543210"
  const contactName = value?.contacts?.[0]?.profile?.name || '';
  const text =
    waMessage.type === 'text'
      ? waMessage.text?.body || ''
      : waMessage.type === 'image'
      ? '[photo]'
      : `[${waMessage.type}]`;

  // 1. Find or create the customer + conversation
  const customer = await Customer.findOneAndUpdate(
    { phone: fromPhone },
    { $setOnInsert: { phone: fromPhone, name: contactName } },
    { upsert: true, new: true }
  );

  let conversation = await Conversation.findOne({ customerPhone: fromPhone });
  if (!conversation) {
    conversation = await Conversation.create({ customerPhone: fromPhone });
  }

  // 2. Save the inbound message
  const inboundMessage = await Message.create({
    conversationId: conversation._id,
    ticketId: conversation.activeTicketId || null,
    direction: 'inbound',
    type: waMessage.type,
    body: text,
    waMessageId: waMessage.id,
  });

  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = text.slice(0, 140);
  conversation.unread = true;

  // 3. If there's already an open ticket for this conversation, just append -
  //    no new automated action, it's now a human conversation.
  if (conversation.activeTicketId) {
    await Ticket.findByIdAndUpdate(conversation.activeTicketId, { lastActivityAt: new Date() });
    await conversation.save();
    return;
  }

  // 4. No open ticket - run triage on plain text messages only.
  if (waMessage.type !== 'text') {
    await conversation.save();
    return;
  }

  if (triage.isStatusOnlyQuery(text)) {
    // Tier 1: auto-answer from Shopify, no ticket created.
    try {
      const orderInfo = await shopify.getLatestOrderStatusByPhone(fromPhone);
      const replyText = shopify.composeStatusReplyText(orderInfo);
      await whatsapp.sendTextMessage(fromPhone, replyText);
      await Message.create({
        conversationId: conversation._id,
        direction: 'outbound',
        type: 'text',
        body: replyText,
      });
    } catch (err) {
      console.error('[webhook] shopify status lookup failed', err.message);
      // Fail safe: don't leave the customer hanging - fall through to a ticket
      // so a human sees it instead of silently dropping the question.
      await createTicketForConversation({ conversation, fromPhone, issueType: 'other', inboundMessage });
    }
    await conversation.save();
    return;
  }

  const issueType = triage.detectIssueType(text);
  if (issueType) {
    // Tier 2: real issue, becomes a ticket.
    await createTicketForConversation({ conversation, fromPhone, issueType, inboundMessage });
    await conversation.save();
    return;
  }

  // Tier 3: general message, left in the normal inbox for you to answer.
  await conversation.save();
}

async function createTicketForConversation({ conversation, fromPhone, issueType, inboundMessage }) {
  const ticketNumber = await Ticket.nextTicketNumber();
  const ticket = await Ticket.create({
    ticketNumber,
    customerPhone: fromPhone,
    conversationId: conversation._id,
    issueType,
    status: 'open',
    lastActivityAt: new Date(),
  });

  conversation.activeTicketId = ticket._id;
  inboundMessage.ticketId = ticket._id;
  await inboundMessage.save();

  const ackText = triage.acknowledgmentMessage(ticketNumber, issueType);
  await whatsapp.sendTextMessage(fromPhone, ackText);
  await Message.create({
    conversationId: conversation._id,
    ticketId: ticket._id,
    direction: 'outbound',
    type: 'text',
    body: ackText,
  });

  return ticket;
}

module.exports = router;
