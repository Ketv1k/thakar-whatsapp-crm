const express = require('express');
const Customer = require('../models/Customer');
const Ticket = require('../models/Ticket');
const shopify = require('../services/shopify');
const customerStatus = require('../services/customerStatus');
const { cleanTags } = require('../services/tags');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// Phone numbers are stored digits-only; guard against odd input.
const PHONE_RE = /^[0-9]{6,15}$/;

// Full CRM profile for one customer, assembled on demand:
//  - who they are + founder's private note (from our DB)
//  - their order history + lifetime spend (live from Shopify)
//  - an automatic New / Returning / VIP status
//  - every past support ticket
// Everything here is automatic except the note - no manual data entry.
router.get('/:phone', asyncHandler(async (req, res) => {
  const phone = req.params.phone;
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid phone' });

  // Our own record (name, note, marketing opt-in). Create-on-read so the
  // profile always exists for anyone who has ever messaged.
  const customer = await Customer.findOneAndUpdate(
    { phone },
    { $setOnInsert: { phone } },
    { upsert: true, new: true }
  ).lean();

  // Live Shopify history - degrade gracefully if it's unconfigured or down,
  // so the profile still shows name, note, and ticket history.
  let shopifySummary = { found: false };
  try {
    shopifySummary = await shopify.getCustomerSummaryByPhone(phone);
  } catch (err) {
    console.error('[customers] shopify summary failed', err.message);
    shopifySummary = { found: false, error: true };
  }

  const status = customerStatus.classify(shopifySummary.ordersCount, shopifySummary.totalSpent);

  const tickets = await Ticket.find({ customerPhone: phone })
    .sort({ lastActivityAt: -1 })
    .limit(50)
    .select('ticketNumber issueType status lastActivityAt resolvedAt')
    .lean();

  res.json({
    phone,
    name: customer.name || shopifySummary.customerName || '',
    notes: customer.notes || '',
    tags: customer.tags || [],
    optedInMarketing: !!customer.optedInMarketing,
    status,
    statusLabel: customerStatus.statusLabel(status),
    shopify: shopifySummary,
    tickets,
  });
}));

// Update the founder-editable bits of a profile (note, tags, marketing opt-in).
router.patch('/:phone', asyncHandler(async (req, res) => {
  const phone = req.params.phone;
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid phone' });

  const update = {};
  if (typeof req.body.notes === 'string') update.notes = req.body.notes.slice(0, 2000);
  if (Array.isArray(req.body.tags)) update.tags = cleanTags(req.body.tags);
  if (typeof req.body.optedInMarketing === 'boolean') update.optedInMarketing = req.body.optedInMarketing;
  if (typeof req.body.name === 'string' && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 120);

  const customer = await Customer.findOneAndUpdate(
    { phone },
    { $set: update, $setOnInsert: { phone } },
    { upsert: true, new: true }
  ).lean();

  res.json({
    phone,
    name: customer.name || '',
    notes: customer.notes || '',
    tags: customer.tags || [],
    optedInMarketing: !!customer.optedInMarketing,
  });
}));

module.exports = router;
