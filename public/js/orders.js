// COD orders: who confirmed, who wants to cancel, who hasn't answered.
import { api, post, el, escapeHtml, formatPhone, ago, money, toast, ico, isCurrent } from './core.js';

const TABS = [
  ['awaiting', 'Waiting for customer'],
  ['cancel_requested', 'Want to cancel'],
  ['confirmed', 'Confirmed'],
];

export async function showOrders(route) {
  const status = TABS.some(([k]) => k === route.id) ? route.id : 'awaiting';
  const view = el('view-orders');
  if (!view.innerHTML) view.innerHTML = '<div class="page"><div class="empty">Loading…</div></div>';
  let d;
  try {
    d = await api(`/api/orders/cod?status=${status}`);
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty"><b>Couldn't load</b>${escapeHtml(err.message)}</div></div>`;
    return;
  }
  if (!isCurrent('orders')) return;
  const empty = {
    awaiting: 'No COD orders waiting. Turn on COD confirmation in Automations and new COD orders get Confirm / Cancel buttons on WhatsApp.',
    cancel_requested: 'No one has asked to cancel.',
    confirmed: 'No confirmed COD orders in the last 30 days.',
  }[status];
  const rows = d.items
    .map((o) => {
      const amount = o.outstanding > 0 ? o.outstanding : o.total;
      const actions = [];
      if (status === 'awaiting') actions.push(`<button type="button" class="btn btn-small btn-ok" data-mark="${o._id}:confirmed">Mark confirmed</button>`);
      if (status === 'awaiting') actions.push(`<button type="button" class="btn btn-small" data-mark="${o._id}:cancel_requested">Mark "wants to cancel"</button>`);
      if (o.conversationId) actions.push(`<a class="btn btn-small" href="#/inbox/${o.conversationId}">${ico('chat')}Chat</a>`);
      if (o.adminUrl) actions.push(`<a class="btn btn-small" href="${escapeHtml(o.adminUrl)}" target="_blank" rel="noopener">${ico('external')}Shopify</a>`);
      const when = status === 'awaiting' ? `asked ${ago(o.cod.requestedAt || o.placedAt)} ago` : `answered ${ago(o.cod.answeredAt)} ago${o.cod.answeredBy === 'founder' ? ' (by you)' : ''}`;
      return `
        <div class="order-row">
          <div class="order-main">
            <b>${escapeHtml(o.name)}${o.simulated ? ' <span class="pill">test</span>' : ''}</b>
            <span>${escapeHtml(o.customerName || formatPhone(o.phone))} · ${escapeHtml(formatPhone(o.phone))}</span>
            <small>${money(amount, o.currency)} to collect · ${escapeHtml(when)}${o.cancelledAt ? ' · cancelled in Shopify' : ''}</small>
          </div>
          <div class="order-actions">${actions.join('')}</div>
        </div>`;
    })
    .join('');
  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">COD orders</h1>
          <p class="page-sub">Cash-on-delivery orders and the customer's answer on WhatsApp. Cancel requests need you to cancel the order in Shopify.</p>
        </div>
      </header>
      <div class="chips" role="tablist">
        ${TABS.map(([k, l]) => `<a role="tab" class="chip-link" aria-selected="${k === status}" href="#/orders/${k}">${escapeHtml(l)} <span>${d.counts[k] || 0}</span></a>`).join('')}
      </div>
      <section class="table-card">${rows || `<div class="empty">${escapeHtml(empty)}</div>`}</section>
    </div>`;
  for (const b of view.querySelectorAll('[data-mark]')) {
    b.addEventListener('click', async () => {
      const [id, next] = b.dataset.mark.split(':');
      try {
        await post(`/api/orders/${id}/cod`, { status: next });
        toast(next === 'confirmed' ? 'Marked as confirmed (tagged in Shopify)' : 'Marked as wanting to cancel');
        showOrders(route);
      } catch (err) {
        toast(err.message);
      }
    });
  }
}
