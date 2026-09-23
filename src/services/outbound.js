// Sends a WhatsApp text and records it in the conversation, with the id
// WhatsApp gave it so the delivery ticks (sent / delivered / read) can be
// matched up later. Every reply the app sends - by the founder or automatic -
// goes through here.
const Message = require('../models/Message');
const whatsapp = require('./whatsapp');

async function sendText({ conversationId, to, body, ticketId = null, autoAck = null, sentByFounder = false }) {
  const result = await whatsapp.sendTextMessage(to, body);
  const waMessageId = result?.messages?.[0]?.id || null;
  return Message.create({
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
  });
}

module.exports = { sendText };
