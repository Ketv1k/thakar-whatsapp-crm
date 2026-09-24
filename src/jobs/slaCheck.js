// Runs on a schedule (wired up in app.js). Pings the founder on WhatsApp when
// a ticket has sat unresolved past SLA_HOURS - this is the piece that actually
// makes the system "foolproof": nothing quietly ages out unnoticed.
const cron = require('node-cron');
const Ticket = require('../models/Ticket');
const whatsapp = require('../services/whatsapp');
const pushNotify = require('../services/pushNotify');
const Conversation = require('../models/Conversation');
const templates = require('../services/templates');
const replyWindow = require('../services/replyWindow');
const { normalizePhone } = require('../utils/phone');

const ISSUES = { delay: 'Late delivery', damaged: 'Damaged', wrong_item: 'Wrong item', missing: 'Missing item', refund_request: 'Refund request', quality: 'Quality complaint', payment: 'Payment issue', other: 'Other issue' };

// WhatsApp only allows free text within 24 hours of that person's last
// message; after that it needs an approved template. So: free text if you've
// messaged the business number recently, the approved alert template if not,
// and otherwise nothing on WhatsApp (the notification still goes out).
async function alertFounderOnWhatsApp(founderPhone, ticket, hours) {
  const phone = normalizePhone(founderPhone);
  if (!phone) return 'no number';
  const own = await Conversation.findOne({ customerPhone: phone }).select('lastInboundAt').lean();
  if (own && replyWindow.isWindowOpen(own.lastInboundAt)) {
    await whatsapp.sendTextMessage(phone, `Reminder: ticket #${ticket.ticketNumber} (${ISSUES[ticket.issueType] || ticket.issueType}) has been unresolved for ${hours}+ hours.`);
    return 'text';
  }
  const template = await templates.findByName('team_ticket_alert');
  if (template && templates.canSend(template)) {
    await whatsapp.sendTemplateMessage(
      phone,
      template.name,
      template.language || 'en',
      templates.sendComponents(template, { bodyParams: [String(ticket.ticketNumber), ISSUES[ticket.issueType] || ticket.issueType, String(hours)] })
    );
    return 'template';
  }
  console.warn('[slaCheck] not alerting on WhatsApp: the "team_ticket_alert" template is not approved yet and the 24-hour window is closed');
  return 'skipped';
}

async function checkOverdueTickets() {
  const slaHours = Number(process.env.SLA_HOURS || 6);
  const founderPhone = process.env.FOUNDER_PHONE;

  const cutoff = new Date(Date.now() - slaHours * 60 * 60 * 1000);

  // Only re-remind once per SLA window, so an ignored ticket doesn't spam you
  // every time the cron runs.
  const overdue = await Ticket.find({
    status: { $in: ['open', 'founder_replied'] },
    lastActivityAt: { $lt: cutoff },
    $or: [{ reminderSentAt: null }, { reminderSentAt: { $lt: cutoff } }],
  });

  for (const ticket of overdue) {
    try {
      await pushNotify.ticketOverdue(ticket, slaHours).catch((err) => console.error('[slaCheck] notification failed', err.message));
      if (founderPhone) await alertFounderOnWhatsApp(founderPhone, ticket, slaHours);
      ticket.reminderSentAt = new Date();
      await ticket.save();
    } catch (err) {
      console.error(`[slaCheck] failed to send reminder for ticket #${ticket.ticketNumber}`, err.message);
    }
  }

  if (overdue.length > 0) {
    console.log(`[slaCheck] sent ${overdue.length} reminder(s)`);
  }
}

// Runs every hour, on the hour.
function startSlaCheckJob() {
  cron.schedule('0 * * * *', checkOverdueTickets);
  console.log('[slaCheck] scheduled (hourly)');
}

module.exports = { startSlaCheckJob, checkOverdueTickets, alertFounderOnWhatsApp };
