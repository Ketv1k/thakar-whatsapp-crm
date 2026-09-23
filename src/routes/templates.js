const express = require('express');
const Template = require('../models/Template');
const templates = require('../services/templates');
const campaigns = require('../services/campaigns');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// Every template the app knows, with Meta's approval status.
router.get('/', asyncHandler(async (req, res) => {
  const list = await Template.find().sort({ source: 1, createdAt: 1 });
  res.json({
    items: list.map(templates.summary),
    metaReady: templates.metaReady(),
    testMode: process.env.TEST_MODE === 'true',
  });
}));

// Pulls approval statuses (and templates made in WhatsApp Manager) from Meta.
router.post('/refresh', asyncHandler(async (req, res) => {
  const result = await templates.refreshFromMeta();
  res.json(result);
}));

// A new marketing template written in the app, e.g. "Diwali offer". Submitted
// to Meta straight away when WhatsApp is connected.
router.post('/', asyncHandler(async (req, res) => {
  const t = await campaigns.createCustomTemplate(req.body || {});
  if (templates.metaReady()) {
    try {
      await templates.submitToMeta(t);
    } catch (err) {
      return res.status(201).json({ ...templates.summary(t), submitError: err.message });
    }
  }
  res.status(201).json(templates.summary(t));
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  const t = await Template.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'template not found' });
  await templates.submitToMeta(t);
  res.json(templates.summary(t));
}));

// Submits every built-in template that hasn't been submitted yet.
router.post('/submit-all', asyncHandler(async (req, res) => {
  const pending = await Template.find({ source: 'catalog', status: { $in: ['not_submitted', 'REJECTED'] } });
  const results = [];
  for (const t of pending) {
    try {
      await templates.submitToMeta(t);
      results.push({ name: t.name, ok: true });
    } catch (err) {
      results.push({ name: t.name, ok: false, error: err.message });
    }
  }
  res.json({ results });
}));

// Only templates made in the app that were never sent to Meta can be deleted.
router.delete('/:id', asyncHandler(async (req, res) => {
  const t = await Template.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'template not found' });
  if (t.source !== 'custom' || t.status !== 'not_submitted') {
    return res.status(400).json({ error: 'Only unsent templates made in the app can be deleted' });
  }
  await t.deleteOne();
  res.json({ ok: true });
}));

module.exports = router;
