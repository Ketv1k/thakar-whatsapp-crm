// Orders (COD answers), product search and back-in-stock requests.
const express = require('express');
const Order = require('../models/Order');
const Conversation = require('../models/Conversation');
const StockAlert = require('../models/StockAlert');
const cod = require('../services/cod');
const shopify = require('../services/shopify');
const backInStock = require('../services/backInStock');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const PHONE_RE = /^[0-9]{6,15}$/;

// COD orders by answer: ?status=awaiting (default) | confirmed | cancel_requested
router.get('/orders/cod', asyncHandler(async (req, res) => {
  const status = ['awaiting', 'confirmed', 'cancel_requested'].includes(req.query.status) ? req.query.status : 'awaiting';
  const filter = status === 'awaiting' ? cod.awaitingQuery() : { isCod: true, 'cod.status': status };
  const [orders, counts] = await Promise.all([
    Order.find(filter).sort({ placedAt: -1 }).limit(100).lean(),
    Promise.all([
      Order.countDocuments(cod.awaitingQuery()),
      Order.countDocuments({ isCod: true, 'cod.status': 'confirmed', 'cod.answeredAt': { $gte: new Date(Date.now() - 30 * 864e5) } }),
      Order.countDocuments({ isCod: true, 'cod.status': 'cancel_requested', cancelledAt: null }),
    ]),
  ]);
  const chats = await Conversation.find({ customerPhone: { $in: orders.map((o) => o.phone).filter(Boolean) } })
    .select('customerPhone')
    .lean();
  const chatByPhone = new Map(chats.map((c) => [c.customerPhone, String(c._id)]));
  res.json({
    status,
    counts: { awaiting: counts[0], confirmed: counts[1], cancel_requested: counts[2] },
    items: orders.map((o) => ({
      _id: o._id,
      name: o.name,
      phone: o.phone,
      customerName: o.customerName,
      total: o.total,
      outstanding: o.outstanding,
      currency: o.currency,
      placedAt: o.placedAt,
      cancelledAt: o.cancelledAt,
      shippedAt: o.shippedAt,
      simulated: o.simulated,
      cod: o.cod,
      conversationId: chatByPhone.get(o.phone) || null,
      adminUrl: o.simulated ? null : shopify.adminOrderUrl(o.shopifyId),
    })),
  });
}));

router.post('/orders/:id/cod', asyncHandler(async (req, res) => {
  const order = await cod.markByFounder(req.params.id, req.body.status);
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json({ ok: true, cod: order.cod });
}));

// Product search for back-in-stock requests.
router.get('/products', asyncHandler(async (req, res) => {
  if (!shopify.isConfigured()) return res.json([]);
  res.json(await shopify.searchProducts(req.query.q));
}));

router.post('/stock-alerts', asyncHandler(async (req, res) => {
  const phone = String(req.body.phone || '');
  const productId = String(req.body.productId || '');
  if (!PHONE_RE.test(phone) || !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    return res.status(400).json({ error: 'Choose a product' });
  }
  const variantId = /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(String(req.body.variantId || '')) ? req.body.variantId : null;
  res.status(201).json(await backInStock.create({ phone, productId, variantId }));
}));

router.delete('/stock-alerts/:id', asyncHandler(async (req, res) => {
  const alert = await StockAlert.findOneAndUpdate(
    { _id: req.params.id, status: 'waiting' },
    { $set: { status: 'cancelled', note: 'Removed by you' } },
    { new: true }
  );
  if (!alert) return res.status(404).json({ error: 'No waiting request found' });
  res.json(alert);
}));

module.exports = router;
