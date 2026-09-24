const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null, index: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    // WhatsApp's message type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'template' ...
    type: { type: String, default: 'text' },
    // The text, or a photo's caption ('[photo]' when it has none).
    body: { type: String, default: '' },
    mediaUrl: { type: String, default: null },
    // Photos, voice notes, videos and files: WhatsApp's media id, used to fetch
    // the file through GET /api/media/:messageId when the inbox shows it.
    media: {
      type: new mongoose.Schema(
        {
          id: String,
          mimeType: String,
          filename: String,
          voice: Boolean,
        },
        { _id: false }
      ),
      default: null,
    },
    waMessageId: { type: String, default: null },
    // Delivery ticks for outgoing messages, from WhatsApp's status webhooks
    // (see services/deliveryStatus.js). null for incoming messages.
    // 'queued' is a campaign message claimed for sending but not sent yet.
    status: { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed'], default: null },
    statusAt: { type: Date, default: null },
    statusError: { type: String, default: undefined },
    sentByFounder: { type: Boolean, default: false },
    // An incoming message still being handled (removed once replies/tickets
    // are done); holds what's needed to finish it after a crash.
    pending: {
      type: new mongoose.Schema({ caption: String, preview: String, payload: String, attempts: Number }, { _id: false }),
      default: undefined,
    },
    // Who on the team sent it (replies and cart links).
    sentBy: {
      type: new mongoose.Schema({ id: String, name: String }, { _id: false }),
      default: undefined,
    },
    // Set on messages the app sent by itself: 'order_status', 'ticket', an
    // acknowledgment category from services/autoAck.js ('greeting', 'photo'...),
    // or an automation ('order_shipped', 'cod_request', 'cart_reminder'...,
    // 'campaign').
    autoAck: { type: String, default: null },
    // Template messages: which template, and the campaign it belongs to.
    templateName: { type: String, default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    // Quick-reply buttons shown under a template message ("Confirm order").
    buttons: { type: [String], default: undefined },
    // Saved while TEST_MODE was on: logged, never actually sent.
    test: { type: Boolean, default: undefined },
    // A cart the founder built in the chat (services/cartLinks.js).
    cart: {
      type: new mongoose.Schema(
        {
          id: String,
          url: String,
          total: Number,
          currency: String,
          items: [{ _id: false, title: String, quantity: Number, price: Number }],
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

// Idempotency guard: Meta retries webhook deliveries aggressively, so the same
// inbound message can arrive more than once. A unique index on the WhatsApp
// message id lets a duplicate insert fail fast (code 11000) instead of creating
// a second copy. A *partial* index (only rows where waMessageId is a string) is
// required rather than `sparse`: outbound messages store waMessageId as an
// explicit null, which a sparse index still treats as an indexed value and would
// reject as a duplicate on the second outbound message.
messageSchema.index(
  { waMessageId: 1 },
  { unique: true, partialFilterExpression: { waMessageId: { $type: 'string' } } }
);

// A campaign reaches each chat at most once, even if sending is interrupted
// and resumed.
messageSchema.index(
  { campaignId: 1, conversationId: 1 },
  { unique: true, partialFilterExpression: { campaignId: { $type: 'objectId' } } }
);
messageSchema.index({ autoAck: 1, createdAt: -1 });
// Finding incoming messages that were never fully handled (webhook.recoverUnfinished).
messageSchema.index({ createdAt: 1 }, { partialFilterExpression: { pending: { $exists: true } } });

module.exports = mongoose.model('Message', messageSchema);
