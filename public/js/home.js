// Home: today at a glance and who needs the founder first.
import { state, api, el, escapeHtml, displayName, avatar, ago, money, ico, ISSUE_LABELS, setInboxCount, isCurrent, plural, shortDate, isOwner } from './core.js';
import { setFilter } from './inbox.js';

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (state.config.founderName || '').split(' ')[0];
  return first ? `${part}, ${first}` : part;
}

function attentionRow(a) {
  let title;
  let pill;
  let href = a.conversationId ? `#/inbox/${a.conversationId}` : '#/orders';
  let sub = `${a.kind === 'cod_cancel' ? 'asked' : 'waiting'} ${ago(a.since)}`;
  if (a.kind === 'follow_up') {
    title = a.note ? `Follow up: ${a.note}` : 'Follow up with them';
    pill = '<span class="pill pill-amber">Reminder</span>';
    href = `#/customers/${a.customerPhone}`;
    sub = `due ${shortDate(a.since)}`;
  } else if (a.kind === 'birthday') {
    title = 'Birthday today 🎂';
    pill = '<span class="pill pill-green">Birthday</span>';
    href = `#/customers/${a.customerPhone}`;
    sub = 'say happy birthday';
  } else if (a.kind === 'needs_reply') {
    title = a.preview || 'New message';
    pill = '<span class="pill pill-clay">Needs reply</span>';
  } else if (a.kind === 'cod_cancel') {
    title = `Wants to cancel COD order ${a.orderName}`;
    pill = '<span class="pill pill-red">Cancel in Shopify</span>';
    href = '#/orders/cancel_requested';
  } else if (a.kind === 'cod_waiting') {
    title = `COD ${a.orderName} · ${money(a.amount, a.currency)} not confirmed`;
    pill = '<span class="pill pill-amber">Not confirmed</span>';
    href = '#/orders';
  } else {
    title = `Ticket #${a.ticketNumber} · ${ISSUE_LABELS[a.issueType] || a.issueType}`;
    pill = a.kind === 'overdue' ? '<span class="pill pill-red">Overdue</span>' : '<span class="pill pill-amber">New ticket</span>';
  }
  return `
    <a class="attention-row" href="${href}">
      ${avatar(a)}
      <span class="attention-main">
        <span class="attention-title">${escapeHtml(title)}</span>
        <span class="attention-sub">${escapeHtml(displayName(a))} · ${escapeHtml(sub)}</span>
      </span>
      ${pill}
    </a>`;
}

function campaignCard(c) {
  if (!c) {
    return `
      <section class="card dark-card">
        <h2>Campaigns</h2>
        <p>Send an offer or a new launch to a group of customers, like everyone who hasn't ordered in 45 days.</p>
        <a class="btn" href="#/campaigns/new">Plan a campaign</a>
      </section>`;
  }
  const readPct = c.sent ? Math.round((c.read / c.sent) * 100) : 0;
  return `
    <section class="card dark-card">
      <span class="eyebrow light">Last campaign</span>
      <h2>${escapeHtml(c.name)}</h2>
      <div class="mini-stats">
        <div><b>${c.sent}</b><span>sent</span></div>
        <div><b>${readPct}%</b><span>read</span></div>
        <div><b>${c.replied}</b><span>replies</span></div>
        <div><b>${c.orders}</b><span>orders</span></div>
      </div>
      <a class="btn" href="#/campaigns/${c._id}">See details</a>
    </section>`;
}

export async function loadHome() {
  const view = el('view-home');
  if (!view.innerHTML) view.innerHTML = '<div class="home"><div class="empty">Loading…</div></div>';
  let d;
  try {
    d = await api('/api/dashboard');
  } catch (err) {
    if (!view.querySelector('.kpis')) view.innerHTML = `<div class="home"><div class="empty"><b>Couldn't load</b>${escapeHtml(err.message)}</div></div>`;
    return;
  }
  setInboxCount(d.needsReply);
  if (!isCurrent('home')) return;

  const k = d.kpis;
  const needCount = d.attention.length;
  const date = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long' });
  const auto = d.automationsToday;
  const aiOn = state.config.ai && state.config.ai.enabled;
  const autoRows = [
    ['Order status questions answered', auto.orderStatus],
    ['Questions answered by AI', auto.aiAnswers],
    ['Order updates sent', auto.orderUpdates],
    ['COD answers', auto.codReplies],
    ['Cart reminders', auto.cartReminders],
    ['Reorder reminders', auto.reorderReminders],
    ['Back-in-stock messages', auto.backInStock],
    ['Instant acknowledgments', auto.acknowledgments],
    ['Tickets opened', auto.ticketsOpened],
  ];

  view.innerHTML = `
    <div class="home">
      <header class="home-head">
        <div class="row"><span class="eyebrow">${escapeHtml(date)}</span>${state.config.testMode ? '<span class="pill pill-amber">Test mode</span>' : ''}</div>
        <h1 class="page-title">${escapeHtml(greeting())}</h1>
        <p>${needCount === 0 ? 'All caught up. Nothing is waiting for you.' : `${plural(needCount, 'thing needs', 'things need')} you.`} ${k.messagesToday.count ? `${plural(k.messagesToday.count, 'message')} today from ${plural(k.messagesToday.customers, 'customer')}.` : ''}</p>
      </header>

      <section class="kpis" aria-label="Today">
        <a class="kpi" href="#/inbox" data-filter-link="tickets">
          <span class="kpi-label">Open tickets</span>
          <span class="kpi-value">${k.tickets.open}</span>
          <span class="kpi-sub ${k.tickets.overdue ? 'bad' : ''}">${k.tickets.overdue ? `${k.tickets.overdue} overdue` : 'none overdue'}</span>
        </a>
        <a class="kpi" href="#/inbox" data-filter-link="needs_reply">
          <span class="kpi-label">Chats waiting</span>
          <span class="kpi-value">${k.chatsWaiting.count}</span>
          <span class="kpi-sub">${k.chatsWaiting.oldestSince ? `oldest ${ago(k.chatsWaiting.oldestSince)}` : 'no one waiting'}</span>
        </a>
        <a class="kpi" href="#/inbox" data-filter-link="all">
          <span class="kpi-label">Answered for you</span>
          <span class="kpi-value">${k.answeredForYou.total}</span>
          <span class="kpi-sub">${k.answeredForYou.ai} AI · ${k.answeredForYou.orderStatus} order status</span>
        </a>
        <a class="kpi" href="#/orders">
          <span class="kpi-label">COD to confirm</span>
          <span class="kpi-value">${k.cod.waiting}</span>
          <span class="kpi-sub ${k.cod.cancelRequests ? 'bad' : ''}">${k.cod.cancelRequests ? `${k.cod.cancelRequests} want to cancel` : k.cod.waiting ? `${money(k.cod.atStake)} to collect` : 'none waiting'}</span>
        </a>
      </section>

      <div class="home-grid">
        <section class="card" aria-labelledby="attn-title">
          <h2 id="attn-title">Needs your attention</h2>
          ${d.attention.map(attentionRow).join('') || `<div class="all-clear">${ico('check')}Nothing waiting. New problems, questions and COD answers show up here.</div>`}
        </section>
        <div class="stack">
          <section class="card" aria-labelledby="auto-title">
            <h2 id="auto-title">Done for you today</h2>
            ${autoRows.filter(([, n]) => n > 0).map(([label, n]) => `<div class="auto-row"><span>${label}</span><b>${n}</b></div>`).join('') || '<p class="card-note">Nothing yet today.</p>'}
            <p class="card-note" style="margin-top:8px">${aiOn ? `AI answers are on (${escapeHtml(state.config.ai.model || state.config.ai.provider)}).` : 'AI answers are off. Add your AI key in Render (AI_API_KEY) to turn them on.'} <a href="#/automations">Automations</a></p>
          </section>
          ${isOwner() ? campaignCard(d.lastCampaign) : ''}
          ${state.config.testMode ? `
          <section class="card">
            <h2>Try it out</h2>
            <p class="card-note">Pretend to be a customer: send a message, place a test order, leave a cart. Nothing is sent on WhatsApp.</p>
            <a class="btn btn-dark" href="#/test" style="margin-top:10px">Open Test</a>
          </section>` : ''}
        </div>
      </div>
    </div>`;

  for (const a of view.querySelectorAll('[data-filter-link]')) {
    a.addEventListener('click', () => setFilter(a.dataset.filterLink, false));
  }
}
