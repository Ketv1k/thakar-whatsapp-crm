// Sends WhatsApp messages and records them in the customer's conversation,
// with the id WhatsApp gave each one so the delivery ticks (sent / delivered /
// read) can be matched up later. Every message the app sends - by the founder
// or automatic - goes through here.
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const whatsapp = require('./whatsapp');
const templates = require('./templates');

function testFlag() {
  return whatsapp.testMode() ? true : undefined;
}

async function sendText({ conversationId, to, body, ticketId = null, autoAck = null, sentByFounder = false, extra = {} }) {
  const result = await whatsapp.sendTextMessage(to, body);
  const waMessageId = result?.messages?.[0]?.id || null;
  return Message.create({
    ...extra,
    conversationId,
    ticketId,
    direction: 'outbound',
    type: 'text',
    body,
    autoAck,
    sentByFounder,
    waMessageId,
    status: 'sent',
    statusAt: new Date(),
    test: testFlag(),
  });
}

// The customer's conversation, created if they've never written. A chat that
// only has automatic messages stays out of the inbox list until they reply.
async function conversationFor(phone, previewIfNew = '') {
  const existing = await Conversation.findOne({ customerPhone: phone });
  if (existing) return existing;
  try {
    return await Conversation.create({
      customerPhone: phone,
      outboundOnly: true,
      unread: false,
      lastMessageAt: new Date(),
      lastMessagePreview: String(previewIfNew).slice(0, 140),
    });
  } catch (err) {
    if (err && err.code === 11000) return Conversation.findOne({ customerPhone: phone });
    throw err;
  }
}

/**
 * Sends an approved template and records it in the chat. Never throws for a
 * WhatsApp refusal: the message is saved as failed with WhatsApp's reason, so
 * the founder can see what happened. Returns { ok, message, error }.
 *
 * kind: what sent it ('order_shipped', 'cart_reminder', 'campaign'...).
 * Automatic messages don't move the chat to the top of the inbox; the inbox is
 * ordered by real conversation.
 */
async function sendTemplate({ to, template, bodyParams = [], headerImageUrl = '', quickReplyPayloads = {}, kind, ticketId = null, campaignId = null, conversation = null }) {
  const body = templates.render(template, bodyParams);
  const convo = conversation || (await conversationFor(to, body));
  const record = {
    conversationId: convo._id,
    ticketId,
    campaignId,
    direction: 'outbound',
    type: 'template',
    body,
    autoAck: kind,
    templateName: template.name,
    buttons: templates.quickReplies(template).length ? templates.quickReplies(template) : undefined,
    test: testFlag(),
  };
  try {
    const result = await whatsapp.sendTemplateMessage(
      to,
      template.name,
      template.language || 'en',
      templates.sendComponents(template, { bodyParams, headerImageUrl, quickReplyPayloads })
    );
    const message = await Message.create({
      ...record,
      waMessageId: result?.messages?.[0]?.id || null,
      status: 'sent',
      statusAt: new Date(),
    });
    return { ok: true, message, conversation: convo };
  } catch (err) {
    const error = whatsapp.describeError(err);
    console.error(`[outbound] template ${template.name} to …${String(to).slice(-4)} failed: ${error}`);
    const message = await Message.create({ ...record, status: 'failed', statusAt: new Date(), statusError: error });
    return { ok: false, message, error, conversation: convo, retryable: whatsapp.isRetryable(err) };
  }
}

// How many times an automatic message is tried before giving up.
const MAX_ATTEMPTS = 3;

// After a failed send: try again on a later run? (Temporary problems only.)
function shouldRetry(result, attemptsSoFar) {
  return !result.ok && !!result.retryable && (attemptsSoFar || 0) + 1 < MAX_ATTEMPTS;
}

module.exports = { sendText, sendTemplate, conversationFor, shouldRetry, MAX_ATTEMPTS };
