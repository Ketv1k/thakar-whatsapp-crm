const express = require('express');
const Conversation = require('../models/Conversation');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const whatsapp = require('../services/whatsapp');
const inboxView = require('../services/inboxView');
const shopify = require('../services/shopify');
const cartLinks = require('../services/cartLinks');
const { formatMoney } = require('../utils/money');
const { replyAsFounder } = require('../services/founderReply');
const { asyncHandler } = require('../utils/asyncHandler');
const aiAnswer = require('../services/aiAnswer');
const users = require('../services/users');

const router = express.Router();

// Small config the Founder Inbox reads once (e.g. to flag tickets past SLA).
router.get('/config', (req, res) => {
  res.json({
    slaHours: Number(process.env.SLA_HOURS || 6),
    testMode: process.env.TEST_MODE === 'true',
    founderName: String(process.env.FOUNDER_NAME || '').trim().slice(0, 40),
    ai: aiAnswer.status(),
    // Who is logged in on this device: { name, role: 'owner' | 'team' }.
    user: users.publicUser(req.user),
  });
});

// Home screen: today's numbers and who needs the founder first.
router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(await inboxView.dashboard());
}));

// The one inbox: every customer's chat, newest first. ?filter=all|needs_reply|tickets
// and ?q= (name, tag, part of a number, or ticket number).
router.get('/inbox', asyncHandler(async (req, res) => {
  const filter = String(req.query.filter || 'all');
  if (!inboxView.FILTERS.includes(filter)) return res.status(400).json({ error: 'invalid filter' });
  res.json(await inboxView.listConversations({ filter, q: req.query.q }));
}));

// Every tag in use, for suggestions when tagging a customer.
router.get('/tags', asyncHandler(async (req, res) => {
  const tags = await Customer.distinct('tags');
  res.json(tags.filter(Boolean).sort((a, b) => a.localeCompare(b)));
}));

// One chat: the customer, open ticket, reply window and every message.
router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const result = await inboxView.getConversation(req.params.id);
  if (!result) return res.status(404).json({ error: 'conversation not found' });
  res.json(result);
}));

router.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const result = await inboxView.getConversation(req.params.id);
  if (!result) return res.status(404).json({ error: 'conversation not found' });
  res.json(result.messages);
}));

router.post('/conversations/:id/reply', asyncHandler(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'conversation not found' });
  res.json(await replyAsFounder({ conversation, body: req.body.body, by: req.user }));
}));

// Builds a cart from the products the founder picked and sends the customer
// a link that opens it on the shop's cart page, ready for address and
// payment (Magic Checkout). Inside the 24-hour reply window, like any reply.
router.post('/conversations/:id/cart-link', asyncHandler(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'conversation not found' });
  const norm = cartLinks.normalizeItems(req.body.items);
  if (norm.error) return res.status(400).json({ error: norm.error });
  if (!shopify.isConfigured()) return res.status(409).json({ error: "Shopify isn't connected, so carts can't be built" });

  let variants;
  try {
    variants = await shopify.variantsByIds(norm.items.map((i) => i.variantId));
  } catch (err) {
    console.error('[cart-link] product check failed', err.message);
    return res.status(502).json({ error: "Couldn't reach Shopify to check the products. Try again in a minute." });
  }
  const byId = new Map(variants.map((v) => [v.id, v]));
  const lines = [];
  for (const item of norm.items) {
    const v = byId.get(item.variantId);
    const name = v ? (v.title ? `${v.productTitle} (${v.title})` : v.productTitle) : 'A product';
    if (!v || !v.active) return res.status(400).json({ error: `${name} is no longer on sale` });
    if (!v.available) return res.status(400).json({ error: `${name} is sold out` });
    lines.push({ productTitle: v.productTitle, variantTitle: v.title, price: v.price, quantity: item.quantity });
  }

  const cartId = cartLinks.newCartId();
  const url = cartLinks.buildCartUrl(shopify.storeUrl(), norm.items, cartId);
  const { text, total } = cartLinks.cartMessage(lines, url);
  const message = await replyAsFounder({
    by: req.user,
    conversation,
    body: text,
    preview: `🛒 Cart link · ${formatMoney(total)}`,
    extra: {
      cart: {
        id: cartId,
        url,
        total,
        currency: 'INR',
        items: lines.map((l) => ({ title: l.variantTitle ? `${l.productTitle} (${l.variantTitle})` : l.productTitle, quantity: l.quantity, price: l.price })),
      },
    },
  });
  res.json(message);
}));

// Manual safety net: turn any chat into a ticket, in case the keyword triage
// missed something.
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
    issueType: String(issueType).slice(0, 40),
    status: 'open',
    lastActivityAt: new Date(),
  });

  conversation.activeTicketId = ticket._id;
  await conversation.save();

  res.json(ticket);
}));

// A photo, voice note, video or file a customer sent, fetched from WhatsApp on
// demand (the inbox loads it with the access code, then shows it).
router.get('/media/:messageId', asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.messageId).select('type media').lean();
  if (!message || !message.media || !message.media.id) return res.status(404).json({ error: 'no file on this message' });

  let file;
  try {
    file = await whatsapp.downloadMedia(message.media.id, message.type);
  } catch (err) {
    console.error('[media] download failed', err.message);
    return res.status(404).json({ error: 'This file is no longer available on WhatsApp' });
  }

  // Only photos, audio and video are shown inline; anything else is handed
  // over as a plain download so a customer's file can never run as a page here.
  // (SVG only for test mode's own stand-in picture; WhatsApp never sends one.)
  const testPicture = process.env.TEST_MODE === 'true' && file.mimeType === 'image/svg+xml';
  const inline = testPicture || /^(image\/(jpeg|png|webp|gif)|audio\/|video\/)/.test(file.mimeType);
  res.set({
    'Content-Type': inline ? file.mimeType : 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  if (file.size) res.set('Content-Length', String(file.size));
  if (!inline) {
    const name = String(message.media.filename || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'file';
    res.set('Content-Disposition', `attachment; filename="${name}"`);
  }
  file.stream.on('error', (err) => {
    console.error('[media] stream failed', err.message);
    res.destroy(err);
  });
  file.stream.pipe(res);
}));

module.exports = router;
