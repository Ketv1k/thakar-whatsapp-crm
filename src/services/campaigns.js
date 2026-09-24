// Campaigns: one approved template sent to a group of customers who opted in
// to offers - now or at a set time.
//
// Safety rules:
//  - only customers who opted in, and not anyone who got an offer in the last
//    CAMPAIGN_MIN_GAP_HOURS (default 24);
//  - each person gets a campaign at most once, even if sending is interrupted
//    (a unique index on campaign + chat; a recipient is claimed before sending);
//  - sending is paced, and stops if WhatsApp keeps refusing.
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Order = require('../models/Order');
const Template = require('../models/Template');
const whatsapp = require('./whatsapp');
const templates = require('./templates');
const outbound = require('./outbound');
const pricing = require('./pricing');
const { customerFilter } = require('./segments');
const { normalizePhone } = require('../utils/phone');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SEND_GAP_MS = Number(process.env.CAMPAIGN_SEND_GAP_MS || 120);
const MAX_CONSECUTIVE_FAILURES = 10;
const running = new Set();

function gapHours() {
  return Number(process.env.CAMPAIGN_MIN_GAP_HOURS || 24);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Who a campaign goes to, as a Mongo filter.
function audienceFilter(audience, now = new Date()) {
  return {
    $and: [
      customerFilter({ segment: audience.segment, tag: audience.tag, filters: audience.filters }, now),
      { optedInMarketing: true },
      { $or: [{ lastMarketingAt: null }, { lastMarketingAt: { $lt: new Date(now.getTime() - gapHours() * HOUR) } }] },
    ],
  };
}

async function estimate(audience, template) {
  const [inGroup, optedIn, eligible] = await Promise.all([
    Customer.countDocuments(customerFilter(audience)),
    Customer.countDocuments({ $and: [customerFilter(audience), { optedInMarketing: true }] }),
    Customer.countDocuments(audienceFilter(audience)),
  ]);
  const category = (template && template.category) || 'MARKETING';
  return { inGroup, optedIn, eligible, recentlyMessaged: optedIn - eligible, category, cost: pricing.estimate(eligible, category), gapHours: gapHours() };
}

function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return /^\+?\d+$/.test(first) ? '' : first;
}

function paramsFor(campaign, customer) {
  return (campaign.bodyParams || []).map((p) =>
    p && p.source === 'first_name' ? firstName(customer.name) || 'there' : String((p && p.text) || '').trim() || '-'
  );
}

// Checks a draft before it can be scheduled. Returns an error string or null.
function problems(campaign, template) {
  if (!template) return 'Choose a message template.';
  if (templates.unsupportedReason(template)) return `This template can't be sent from the app: ${templates.unsupportedReason(template)}.`;
  if (!templates.canSend(template)) return 'This template is not approved by Meta yet.';
  const count = templates.paramCount(template);
  for (let i = 0; i < count; i++) {
    const p = (campaign.bodyParams || [])[i];
    if (!p || (p.source !== 'first_name' && !String(p.text || '').trim())) return `Fill in blank {{${i + 1}}}.`;
  }
  if (templates.headerFormat(template) === 'IMAGE' && !/^https:\/\/\S+$/i.test(campaign.headerImageUrl || '')) {
    return 'This template has a photo at the top: paste a link to the photo (starting with https://).';
  }
  return null;
}

// Claims one recipient, sends, records. Returns 'sent' | 'failed' | 'already'.
async function sendOne(campaign, template, customer) {
  const bodyParams = paramsFor(campaign, customer);
  const body = templates.render(template, bodyParams);
  const conversation = await outbound.conversationFor(customer.phone, body);
  let message;
  try {
    message = await Message.create({
      conversationId: conversation._id,
      campaignId: campaign._id,
      direction: 'outbound',
      type: 'template',
      body,
      autoAck: 'campaign',
      templateName: template.name,
      buttons: templates.quickReplies(template).length ? templates.quickReplies(template) : undefined,
      status: 'queued',
      statusAt: new Date(),
      test: whatsapp.testMode() ? true : undefined,
    });
  } catch (err) {
    if (err && err.code === 11000) return { result: 'already' };
    throw err;
  }
  try {
    const res = await whatsapp.sendTemplateMessage(
      customer.phone,
      template.name,
      template.language || 'en',
      templates.sendComponents(template, { bodyParams, headerImageUrl: campaign.headerImageUrl })
    );
    message.waMessageId = res?.messages?.[0]?.id || null;
    message.status = 'sent';
    message.statusAt = new Date();
    await message.save();
    await Customer.updateOne({ phone: customer.phone }, { $set: { lastMarketingAt: new Date() } });
    return { result: 'sent' };
  } catch (err) {
    const error = whatsapp.describeError(err);
    message.status = 'failed';
    message.statusError = error;
    message.statusAt = new Date();
    await message.save();
    return { result: 'failed', error, code: err?.response?.data?.error?.code };
  }
}

async function refreshCounts(campaignId) {
  const rows = await Message.aggregate([
    { $match: { campaignId } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const failed = by.failed || 0;
  const sent = (by.sent || 0) + (by.delivered || 0) + (by.read || 0);
  await Campaign.updateOne({ _id: campaignId }, { $set: { 'counts.sent': sent, 'counts.failed': failed } });
  return { sent, failed };
}

// Sends (or resumes sending) a campaign. Safe to call again: people already
// sent to are skipped.
async function run(campaignId) {
  const key = String(campaignId);
  if (running.has(key)) return { busy: true };
  running.add(key);
  try {
    const now = new Date();
    const campaign = await Campaign.findOneAndUpdate(
      { _id: campaignId, status: { $in: ['scheduled', 'sending'] } },
      { $set: { status: 'sending' } },
      { new: true }
    );
    if (!campaign) return { skipped: true };
    if (!campaign.startedAt) {
      campaign.startedAt = now;
      campaign.counts.audience = await Customer.countDocuments(audienceFilter(campaign.audience, now));
      await campaign.save();
    }
    const template = campaign.templateId ? await Template.findById(campaign.templateId) : null;
    const problem = problems(campaign, template);
    if (problem) {
      await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'failed', lastError: problem, finishedAt: new Date() } });
      return { failed: problem };
    }
    // A claim left over from an interrupted run was never sent: close it out.
    await Message.updateMany(
      { campaignId: campaign._id, status: 'queued', statusAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
      { $set: { status: 'failed', statusError: 'Interrupted before sending' } }
    );

    let consecutiveFailures = 0;
    let lastError = null;
    const cursor = Customer.find(audienceFilter(campaign.audience, campaign.startedAt)).select('phone name').lean().cursor();
    for await (const customer of cursor) {
      if (!normalizePhone(customer.phone)) continue;
      const current = await Campaign.findById(campaign._id).select('status').lean();
      if (!current || current.status !== 'sending') break; // cancelled meanwhile
      const out = await sendOne(campaign, template, customer);
      if (out.result === 'failed') {
        consecutiveFailures++;
        lastError = out.error;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      } else if (out.result === 'sent') {
        consecutiveFailures = 0;
      }
      if (out.result !== 'already') await sleep(SEND_GAP_MS);
    }
    const counts = await refreshCounts(campaign._id);
    const stoppedEarly = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    const finalStatus = await Campaign.findById(campaign._id).select('status').lean();
    if (finalStatus && finalStatus.status === 'sending') {
      await Campaign.updateOne(
        { _id: campaign._id },
        {
          $set: {
            status: stoppedEarly ? 'failed' : 'sent',
            finishedAt: new Date(),
            lastError: stoppedEarly ? `Stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row. WhatsApp said: ${lastError}` : lastError,
          },
        }
      );
    }
    return { ...counts, stoppedEarly };
  } finally {
    running.delete(key);
  }
}

// Called every minute by the scheduler: starts due campaigns and resumes any
// that were interrupted (e.g. the server restarted mid-send).
async function runDue(now = new Date()) {
  const due = await Campaign.find({
    $or: [{ status: 'scheduled', scheduledAt: { $lte: now } }, { status: 'sending' }],
  })
    .select('_id')
    .lean();
  const results = [];
  for (const c of due) {
    if (!running.has(String(c._id))) results.push(await run(c._id));
  }
  return results;
}

// Delivery, reads, replies and orders for a campaign.
async function stats(campaign) {
  const rows = await Message.aggregate([
    { $match: { campaignId: campaign._id } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const read = by.read || 0;
  const delivered = (by.delivered || 0) + read;
  const sent = (by.sent || 0) + delivered;
  const failed = by.failed || 0;
  const out = { sent, delivered, read, failed, queued: by.queued || 0, replied: 0, orders: 0, revenue: 0, orderList: [] };
  if (!campaign.startedAt || sent === 0) return out;

  const convIds = await Message.distinct('conversationId', { campaignId: campaign._id, status: { $ne: 'failed' } });
  const replyUntil = new Date(campaign.startedAt.getTime() + 3 * DAY);
  const replied = await Message.distinct('conversationId', {
    conversationId: { $in: convIds },
    direction: 'inbound',
    createdAt: { $gte: campaign.startedAt, $lte: replyUntil },
  });
  out.replied = replied.length;

  const Conversation = require('../models/Conversation');
  const phones = await Conversation.distinct('customerPhone', { _id: { $in: convIds } });
  const orders = await Order.find({
    phone: { $in: phones },
    placedAt: { $gte: campaign.startedAt, $lte: new Date(campaign.startedAt.getTime() + 7 * DAY) },
    cancelledAt: null,
  })
    .sort({ placedAt: 1 })
    .select('name customerName phone total placedAt')
    .lean();
  out.orders = orders.length;
  out.revenue = Math.round(orders.reduce((s, o) => s + (o.total || 0), 0));
  out.orderList = orders.slice(0, 100).map((o) => ({ name: o.name, customerName: o.customerName, phone: o.phone, total: o.total, placedAt: o.placedAt }));
  return out;
}

// Sends the campaign's message to the founder's own number to check it.
async function sendTest(campaign, template, founderName) {
  const phone = normalizePhone(process.env.FOUNDER_PHONE);
  if (!phone) {
    throw Object.assign(new Error('Add your own WhatsApp number (FOUNDER_PHONE) in the server settings first.'), { status: 409, expose: true });
  }
  const problem = problems(campaign, template);
  if (problem) throw Object.assign(new Error(problem), { status: 400, expose: true });
  return outbound.sendTemplate({
    to: phone,
    template,
    bodyParams: paramsFor(campaign, { name: founderName || 'there' }),
    headerImageUrl: campaign.headerImageUrl,
    kind: 'campaign_test',
  });
}

// A marketing template written in the app (for campaigns).
async function createCustomTemplate({ label, body, buttonText, buttonUrl, stopButton = true, examples = [] }) {
  const cleanLabel = String(label || '').trim().slice(0, 60);
  if (!cleanLabel) throw Object.assign(new Error('Give the message a name.'), { status: 400, expose: true });
  const text = String(body || '').trim();
  const bodyError = templates.validateBody(text);
  if (bodyError) throw Object.assign(new Error(bodyError), { status: 400, expose: true });
  let urlButton = null;
  if (buttonText || buttonUrl) {
    const btn = String(buttonText || '').trim();
    const url = String(buttonUrl || '').trim();
    if (!btn || btn.length > 25) throw Object.assign(new Error('Button text: 1 to 25 characters.'), { status: 400, expose: true });
    if (!/^https:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error('Button link must start with https://'), { status: 400, expose: true });
    urlButton = { text: btn, url };
  }
  const base = templates.slugify(cleanLabel) || 'offer';
  let name = base;
  for (let i = 2; await Template.exists({ name, language: 'en' }); i++) name = `${base}_${i}`;
  const count = [...text.matchAll(/\{\{(\d+)\}\}/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
  const ex = [];
  for (let i = 0; i < count; i++) ex.push(String(examples[i] || '').trim() || (i === 0 ? 'Priya' : 'Thakar Kitchen'));
  return Template.create({
    name,
    language: 'en',
    category: 'MARKETING',
    label: cleanLabel,
    source: 'custom',
    examples: ex,
    components: templates.buildComponents({ body: text, examples: ex, quickReplies: stopButton ? [templates.STOP_BUTTON] : [], urlButton }),
    status: 'not_submitted',
  });
}

module.exports = {
  audienceFilter,
  estimate,
  paramsFor,
  problems,
  run,
  runDue,
  stats,
  sendTest,
  createCustomTemplate,
  firstName,
  gapHours,
};
