// Runs on a schedule (wired up in app.js). Pings the founder on WhatsApp when
// a ticket has sat unresolved past SLA_HOURS - this is the piece that actually
// makes the system "foolproof": nothing quietly ages out unnoticed.
const cron = require('node-cron');
const Ticket = require('../models/Ticket');
const whatsapp = require('../services/whatsapp');

async function checkOverdueTickets() {
  const slaHours = Number(process.env.SLA_HOURS || 6);
  const founderPhone = process.env.FOUNDER_PHONE;
  if (!founderPhone) {
    console.warn('[slaCheck] FOUNDER_PHONE not set, skipping SLA check');
    return;
  }

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
      await whatsapp.sendTextMessage(
        founderPhone,
        `Reminder: ticket #${ticket.ticketNumber} (${ticket.issueType}) has been unresolved for ${slaHours}+ hours.`
      );
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

module.exports = { startSlaCheckJob, checkOverdueTickets };
