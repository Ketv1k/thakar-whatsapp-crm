const express = require('express');
const Customer = require('../models/Customer');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const outbound = require('../services/outbound');
const deliveryStatus = require('../services/deliveryStatus');
const { describeInbound } = require('../services/messageContent');
const shopify = require('../services/shopify');
const triage = require('../services/ticketTriage');
const autoAck = require('../services/autoAck');
const aiAnswer = require('../services/aiAnswer');

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

  // One delivery can batch several entries/changes; each change carries
  // customer messages and/or delivery ticks for messages we sent.
  for (const entry of req.body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      if (!value) continue;
      for (const status of value.statuses || []) {
        try {
          await deliveryStatus.applyStatus(status);
        } catch (err) {
          console.error('[webhook] error applying delivery status', err);
        }
      }
      for (const waMessage of value.messages || []) {
        try {
          await handleIncomingMessage(waMessage, value);
        } catch (err) {
          console.error('[webhook] error handling incoming message', err);
        }
      }
    }
  }
});

async function handleIncomingMessage(waMessage, value) {
  const fromPhone = waMessage.from; // digits only, e.g. "919876543210"
  if (!fromPhone || !waMessage.id) {
    console.warn('[webhook] skipping message with no sender or id');
    return;
  }

  // Idempotency: Meta retries deliveries, so bail out if we've already logged
  // this WhatsApp message id - otherwise we'd double-reply and open duplicate
  // tickets. The unique index on waMessageId is the race-proof backstop below.
  if (await Message.exists({ waMessageId: waMessage.id })) {
    return;
  }

  const contactName = value?.contacts?.[0]?.profile?.name || '';
  const content = describeInbound(waMessage);
  const text = content.body;

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

  // 2. Save the inbound message. If a concurrent retry beat us to it, the
  //    unique waMessageId index throws a duplicate-key error - treat that as
  //    "already handled" and stop, before any reply or ticket is created.
  let inboundMessage;
  try {
    inboundMessage = await Message.create({
      conversationId: conversation._id,
      ticketId: conversation.activeTicketId || null,
      direction: 'inbound',
      type: content.type,
      body: text,
      media: content.media,
      waMessageId: waMessage.id,
    });
  } catch (err) {
    if (err && err.code === 11000) return;
    throw err;
  }

  conversation.lastMessageAt = new Date();
  conversation.lastInboundAt = conversation.lastMessageAt;
  conversation.lastMessagePreview = content.preview;
  conversation.unread = true;

  // 3. If there's already an open ticket for this conversation, just append -
  //    no new automated action, it's now a human conversation. The customer
  //    has written again, so the ticket is back to waiting on the founder.
  if (conversation.activeTicketId) {
    await Ticket.findByIdAndUpdate(conversation.activeTicketId, { lastActivityAt: new Date(), status: 'open' });
    await conversation.save();
    return;
  }

  // 4. No open ticket - run triage on plain text messages only. A photo whose
  //    caption describes a problem ("box arrived broken") opens a ticket;
  //    other photos, voice notes etc. get an instant acknowledgment and wait
  //    in the inbox.
  if (content.type !== 'text') {
    const captionIssue = content.caption ? triage.detectIssueType(content.caption) : null;
    if (captionIssue) {
      await createTicketForConversation({ conversation, fromPhone, issueType: captionIssue });
      await conversation.save();
      return;
    }
    await conversation.save();
    await sendAutoAckIfDue(conversation, fromPhone, autoAck.categorize(content.type, text));
    return;
  }

  if (triage.isStatusOnlyQuery(text)) {
    // Tier 1: auto-answer from Shopify, no ticket created.
    try {
      const orderInfo = await shopify.getLatestOrderStatusByPhone(fromPhone);
      const replyText = shopify.composeStatusReplyText(orderInfo);
      await outbound.sendText({ conversationId: conversation._id, to: fromPhone, body: replyText, autoAck: 'order_status' });
      // Already answered - show the reply as the latest message and don't flag
      // the chat as needing the founder.
      conversation.lastMessagePreview = replyText.slice(0, 140);
      conversation.unread = false;
    } catch (err) {
      console.error('[webhook] shopify status lookup failed', err.message);
      // Fail safe: don't leave the customer hanging - fall through to a ticket
      // so a human sees it instead of silently dropping the question.
      await createTicketForConversation({ conversation, fromPhone, issueType: 'other' });
    }
    await conversation.save();
    return;
  }

  const issueType = triage.detectIssueType(text);
  if (issueType) {
    // Tier 2: real issue, becomes a ticket.
    await createTicketForConversation({ conversation, fromPhone, issueType });
    await conversation.save();
    return;
  }

  // Tier 3: general message. If the shop's own information answers it, the AI
  // replies with the answer; otherwise an instant acknowledgment that fits what
  // they said, and it waits in Chats for the founder.
  await conversation.save();
  const category = autoAck.categorize('text', text);
  if (await answerWithAi({ conversation, fromPhone, text, category, inboundMessage })) return;
  await sendAutoAckIfDue(conversation, fromPhone, category);
}

// Greetings, compliments and bulk requests keep their fixed replies; these
// kinds of message can get a real answer from the shop's information.
const AI_CATEGORIES = new Set(['question', 'delivery_area', 'general']);

async function answerWithAi({ conversation, fromPhone, text, category, inboundMessage }) {
  if (!AI_CATEGORIES.has(category) || !aiAnswer.isConfigured()) return false;
  if (await founderIsActive(conversation)) return false;

  const history = await Message.find({
    conversationId: conversation._id,
    _id: { $ne: inboundMessage._id },
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  })
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  const result = await aiAnswer.answer(text, history.reverse());
  if (!result || !result.answered) return false;

  await outbound.sendText({ conversationId: conversation._id, to: fromPhone, body: result.reply, autoAck: 'ai_answer' });
  // Answered - show the reply as the latest message and don't flag the chat.
  conversation.lastMessagePreview = result.reply.slice(0, 140);
  conversation.unread = false;
  await conversation.save();
  return true;
}

// The founder has personally replied to this customer recently, so automatic
// replies stay out of the conversation.
function founderIsActive(conversation) {
  const since = new Date(Date.now() - autoAck.cooldownHours() * 60 * 60 * 1000);
  return Message.exists({ conversationId: conversation._id, sentByFounder: true, createdAt: { $gte: since } });
}

// Sends the acknowledgment unless it would be noise: none fits (e.g. "ok
// thanks"), the founder is already talking to this customer, or the same kind
// of acknowledgment went out recently.
async function sendAutoAckIfDue(conversation, fromPhone, category) {
  if (!category) return;
  const since = new Date(Date.now() - autoAck.cooldownHours() * 60 * 60 * 1000);
  const [founderActive, alreadySent] = await Promise.all([
    founderIsActive(conversation),
    Message.exists({ conversationId: conversation._id, autoAck: category, createdAt: { $gte: since } }),
  ]);
  if (founderActive || alreadySent) return;

  const reply = autoAck.replyFor(category);
  await outbound.sendText({ conversationId: conversation._id, to: fromPhone, body: reply, autoAck: category });
}

async function createTicketForConversation({ conversation, fromPhone, issueType }) {
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
  // Pull this message and the last day's un-ticketed messages into the ticket,
  // so e.g. a photo sent just before describing the problem shows up with it.
  await Message.updateMany(
    {
      conversationId: conversation._id,
      ticketId: null,
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    { ticketId: ticket._id }
  );

  const ackText = triage.acknowledgmentMessage(ticketNumber, issueType);
  await outbound.sendText({
    conversationId: conversation._id,
    ticketId: ticket._id,
    to: fromPhone,
    body: ackText,
    autoAck: 'ticket',
  });

  return ticket;
}

module.exports = router;
module.exports.handleIncomingMessage = handleIncomingMessage;
