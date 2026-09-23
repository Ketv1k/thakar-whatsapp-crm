// Which WhatsApp updates an order needs right now. Pure: takes the order, the
// automation switches and the time, returns what to send and what to skip.
//
// Rules that keep this safe:
//  - an update only goes out if its automation was already on when the thing
//    happened (switching "Shipped" on never messages last week's orders);
//  - updates older than their window are dropped, so a sync after downtime
//    doesn't send "out for delivery" the next day;
//  - when several are due at once, only the newest goes (no "shipped" and
//    "delivered" back to back).
const { activeFor } = require('./automations');

const HOUR = 60 * 60 * 1000;
const WINDOWS = {
  confirmed: 24 * HOUR,
  cod_request: 24 * HOUR,
  shipped: 48 * HOUR,
  out_for_delivery: 12 * HOUR,
  delivered: 48 * HOUR,
};

// Which automation switch controls each update.
const AUTOMATION_FOR = {
  confirmed: 'order_confirmed',
  cod_request: 'cod_confirmation',
  shipped: 'order_shipped',
  out_for_delivery: 'order_out_for_delivery',
  delivered: 'order_delivered',
};

function recent(at, windowMs, now) {
  if (!at) return false;
  const age = now.getTime() - new Date(at).getTime();
  return age <= windowMs && age >= -5 * 60 * 1000;
}

function dueEvents(order, autos, now = new Date()) {
  const send = [];
  const skip = [];
  if (!order || !order.phone || order.cancelledAt) return { send, skip };
  if (order.shopifyTest && !order.simulated) return { send, skip };
  const done = order.notified || {};

  const due = (event, at) =>
    !done[event] && activeFor(autos[AUTOMATION_FOR[event]], at) && recent(at, WINDOWS[event], now);

  // Shipping progress: only the most advanced update that's due.
  const shippingDue = [];
  if (due('delivered', order.deliveredAt)) shippingDue.push('delivered');
  if (!order.deliveredAt && due('out_for_delivery', order.outForDeliveryAt)) shippingDue.push('out_for_delivery');
  if (due('shipped', order.shippedAt)) shippingDue.push('shipped');
  if (shippingDue.length) {
    send.push(shippingDue[0]);
    for (const e of shippingDue.slice(1)) skip.push({ event: e, reason: `Skipped: "${shippingDue[0]}" went instead` });
  }

  // Placing the order: a COD order gets the confirm/cancel request (unless it
  // already shipped); everyone else the plain "order confirmed".
  const codOn = order.isCod && autos.cod_confirmation && autos.cod_confirmation.enabled;
  if (codOn) {
    if (!done.cod_request && !done.confirmed && !order.shippedAt && due('cod_request', order.placedAt)) {
      send.unshift('cod_request');
    }
  } else if (!done.confirmed && !done.cod_request && due('confirmed', order.placedAt)) {
    if (shippingDue.length) skip.push({ event: 'confirmed', reason: 'Skipped: it had already shipped' });
    else send.unshift('confirmed');
  }
  return { send, skip };
}

module.exports = { dueEvents, WINDOWS, AUTOMATION_FOR };
