// Background jobs for the automations. Each job runs on its own timer and
// never overlaps itself; a failure is logged and shown on the Automations page
// but never stops the others.
//
//   every minute      campaigns that are due (and resuming interrupted ones)
//   every 5 minutes   Shopify orders -> order updates + COD confirmation
//   every 15 minutes  abandoned carts -> cart reminders
//   every 30 minutes  back-in-stock checks
//   hourly            reorder reminders (daytime only)
//   hourly            customer numbers from orders (first run imports order history)
//   every 6 hours     Shopify customers (order counts, spend, groups)
//
// On a free Render plan the server sleeps when unused; the syncs catch up on
// wake-up because they ask Shopify for everything since their last run.
const cron = require('node-cron');
const settings = require('../services/settings');

const JOBS = {
  orders: () => require('../services/orderSync').syncOrders(),
  carts: () => require('../services/cartRecovery').run(),
  stock: () => require('../services/backInStock').run(),
  reorder: () => require('../services/reorder').run(),
  customers: () => require('../services/customerSync').syncCustomers(),
  insights: () => require('../services/customerInsights').run(),
  campaigns: () => require('../services/campaigns').runDue(),
};

const running = new Set();

// Runs a job unless it's already running. Returns its result or { busy }.
async function runJob(name) {
  if (!JOBS[name]) throw Object.assign(new Error('Unknown job'), { status: 400, expose: true });
  if (running.has(name)) return { busy: true };
  running.add(name);
  const startedAt = new Date();
  try {
    const result = await JOBS[name]();
    await settings.merge(`job:${name}`, { lastRunAt: startedAt, lastResult: result || null, lastError: null });
    return result;
  } catch (err) {
    console.error(`[jobs] ${name} failed:`, err.message);
    await settings.merge(`job:${name}`, { lastRunAt: startedAt, lastError: err.message.slice(0, 300) }).catch(() => {});
    return { error: err.message };
  } finally {
    running.delete(name);
  }
}

function isRunning(name) {
  return running.has(name);
}

function startScheduler() {
  const schedule = (expr, name) => cron.schedule(expr, () => runJob(name), { timezone: 'Asia/Kolkata' });
  schedule('* * * * *', 'campaigns');
  schedule('*/5 * * * *', 'orders');
  schedule('2,17,32,47 * * * *', 'carts');
  schedule('7,37 * * * *', 'stock');
  schedule('20 * * * *', 'reorder');
  schedule('40 */6 * * *', 'customers');
  schedule('25 * * * *', 'insights');
  // Catch up shortly after start-up (e.g. after the server slept).
  setTimeout(() => runJob('orders').then(() => runJob('customers')).then(() => runJob('insights')), 20 * 1000).unref();
  console.log('[jobs] automations scheduled');
}

module.exports = { startScheduler, runJob, isRunning, JOBS };
