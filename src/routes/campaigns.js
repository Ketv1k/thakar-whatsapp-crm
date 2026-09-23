const express = require('express');
const Campaign = require('../models/Campaign');
const Message = require('../models/Message');
const Template = require('../models/Template');
const campaigns = require('../services/campaigns');
const templates = require('../services/templates');
const segments = require('../services/segments');
const { runJob } = require('../jobs/scheduler');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

function cleanDraft(body = {}) {
  const out = {};
  if (typeof body.name === 'string') out.name = body.name.trim().slice(0, 80) || 'Untitled campaign';
  if (body.audience && typeof body.audience === 'object') {
    out.audience = {
      segment: segments.isSegment(body.audience.segment) ? body.audience.segment : 'all',
      tag: String(body.audience.tag || '').slice(0, 30),
    };
  }
  if (body.templateId !== undefined) out.templateId = /^[a-f0-9]{24}$/.test(String(body.templateId || '')) ? body.templateId : null;
  if (Array.isArray(body.bodyParams)) {
    out.bodyParams = body.bodyParams.slice(0, 20).map((p) => ({
      source: p && p.source === 'first_name' ? 'first_name' : 'text',
      text: String((p && p.text) || '').slice(0, 200),
    }));
  }
  if (typeof body.headerImageUrl === 'string') out.headerImageUrl = body.headerImageUrl.trim().slice(0, 1000);
  return out;
}

async function withTemplate(campaign) {
  return campaign.templateId ? Template.findById(campaign.templateId) : null;
}

// All campaigns, newest first, with headline numbers.
router.get('/', asyncHandler(async (req, res) => {
  const list = await Campaign.find().sort({ createdAt: -1 }).limit(100).lean();
  const rows = await Message.aggregate([
    { $match: { campaignId: { $in: list.map((c) => c._id) } } },
    { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const by = {};
  for (const r of rows) {
    const k = String(r._id.c);
    by[k] = by[k] || {};
    by[k][r._id.s] = r.n;
  }
  const tpl = new Map(
    (await Template.find({ _id: { $in: list.map((c) => c.templateId).filter(Boolean) } }).select('label name').lean()).map((t) => [String(t._id), t])
  );
  res.json(
    list.map((c) => {
      const s = by[String(c._id)] || {};
      const read = s.read || 0;
      const delivered = (s.delivered || 0) + read;
      const sent = (s.sent || 0) + delivered;
      const t = c.templateId ? tpl.get(String(c.templateId)) : null;
      return { ...c, templateLabel: t ? t.label || t.name : '', live: { sent, delivered, read, failed: s.failed || 0 } };
    })
  );
}));

// How many people a group reaches and what it costs, for the composer.
router.get('/estimate', asyncHandler(async (req, res) => {
  const audience = {
    segment: segments.isSegment(req.query.segment) ? req.query.segment : 'all',
    tag: String(req.query.tag || '').slice(0, 30),
  };
  const template = /^[a-f0-9]{24}$/.test(String(req.query.templateId || '')) ? await Template.findById(req.query.templateId) : null;
  res.json(await campaigns.estimate(audience, template));
}));

router.post('/', asyncHandler(async (req, res) => {
  const draft = cleanDraft(req.body);
  const c = await Campaign.create({ name: draft.name || 'Untitled campaign', ...draft, status: 'draft' });
  res.status(201).json(c);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  const template = await withTemplate(c);
  res.json({
    campaign: c,
    template: template ? templates.summary(template) : null,
    stats: await campaigns.stats(c),
    problem: ['draft', 'scheduled'].includes(c.status) ? campaigns.problems(c, template) : null,
  });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  if (!['draft', 'scheduled'].includes(c.status)) return res.status(400).json({ error: 'This campaign has already gone out' });
  Object.assign(c, cleanDraft(req.body));
  await c.save();
  res.json(c);
}));

// Schedule for later (sendAt) or send now (now: true).
router.post('/:id/schedule', asyncHandler(async (req, res) => {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  if (!['draft', 'scheduled'].includes(c.status)) return res.status(400).json({ error: 'This campaign has already gone out' });
  const template = await withTemplate(c);
  const problem = campaigns.problems(c, template);
  if (problem) return res.status(400).json({ error: problem });
  const estimate = await campaigns.estimate(c.audience, template);
  if (estimate.eligible === 0) {
    return res.status(400).json({
      error: estimate.optedIn > 0
        ? `Everyone in this group who opted in already got an offer in the last ${estimate.gapHours} hours. Try again later.`
        : 'No one in this group has opted in to offers yet, so no one can receive it.',
    });
  }

  const now = req.body.now === true;
  const sendAt = now ? new Date() : new Date(req.body.sendAt);
  if (Number.isNaN(sendAt.getTime())) return res.status(400).json({ error: 'Pick a date and time' });
  if (!now && sendAt.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'That time has passed' });
  c.status = 'scheduled';
  c.scheduledAt = sendAt;
  c.lastError = null;
  await c.save();
  if (now) runJob('campaigns'); // starts right away, in the background
  res.json(c);
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const c = await Campaign.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['scheduled', 'sending'] } },
    { $set: { status: 'cancelled', finishedAt: new Date() } },
    { new: true }
  );
  if (!c) return res.status(400).json({ error: 'Only a scheduled or sending campaign can be stopped' });
  res.json(c);
}));

router.post('/:id/test', asyncHandler(async (req, res) => {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  const result = await campaigns.sendTest(c, await withTemplate(c), process.env.FOUNDER_NAME);
  if (!result.ok) return res.status(502).json({ error: `WhatsApp didn't send it: ${result.error}` });
  res.json({ ok: true, conversationId: result.conversation._id });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  if (c.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be deleted' });
  await c.deleteOne();
  res.json({ ok: true });
}));

module.exports = router;
