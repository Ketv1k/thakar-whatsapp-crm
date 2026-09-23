// Thakar Kitchen inbox - a single-page vanilla JS app. No build step on
// purpose: easy to read and tweak without a toolchain.
//
// Screens (hash routes):
//   #/home                    today at a glance
//   #/inbox                   every customer's chat, with search and filters
//   #/inbox/<id>              one chat (on a computer: list, chat and customer side by side)
//   #/inbox/<id>/customer     the customer's details (phones and narrower screens)
//   #/test                    pretend to be a customer (test mode only)

const API_KEY_STORAGE = 'thakar_inbox_api_key';
const POLL_MS = 12000;

const QUICK_REPLIES = [
  "Thanks, we're on it!",
  'Your order has been dispatched.',
  "Sorry for the trouble, we'll make this right.",
  'Refund initiated, it should reflect in 3-5 days.',
  'A replacement is on its way.',
];

// Plain-English labels so the founder never sees internal codes.
const ISSUE_LABELS = {
  delay: 'Late delivery',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  missing: 'Missing item',
  refund_request: 'Refund request',
  quality: 'Quality complaint',
  payment: 'Payment issue',
  other: 'Other issue',
};
const ISSUE_TYPES = ['delay', 'damaged', 'wrong_item', 'missing', 'quality', 'payment', 'refund_request', 'other'];

// What the app sent by itself, shown above the message.
const AUTO_LABELS = {
  order_status: 'Auto-reply · Order status',
  ai_answer: 'Auto-reply · AI answer',
  ticket: 'Auto-reply · Ticket opened',
};

const AVATAR_COLOURS = ['#F2B829', '#E9B99A', '#D9C6A5', '#C9D8B6', '#E3C9E1', '#BFD3E6', '#F2D39B'];

// Lucide-style line icons, drawn inline so the app needs no icon files.
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-4-.9L3 20l1.1-4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
const TICK_ONE = '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 3 3 6-7"/></svg>';
const TICK_TWO = '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1 6 3 3 6-7"/><path d="m7 9 6-7"/></svg>';

// ---------- State ----------
let apiKey = localStorage.getItem(API_KEY_STORAGE) || '';
let config = { slaHours: 6, testMode: false, founderName: '', ai: null };
const inbox = { filter: 'all', q: '', items: [], counts: null, loaded: false };
let thread = null; // { id, conversation, messages }
let profile = null; // loaded customer profile for the open chat
let knownTags = [];
const mediaUrls = new Map(); // message id -> object URL
let route = { view: 'home', id: null, pane: 'list' };

const el = (id) => document.getElementById(id);

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let message = `Something went wrong (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch (err) {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Small helpers ----------
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPhone(phone) {
  const p = String(phone || '');
  if (/^91\d{10}$/.test(p)) return `+91 ${p.slice(2, 7)} ${p.slice(7)}`;
  return p ? `+${p}` : '';
}

function displayName(item) {
  return (item.customerName && item.customerName.trim()) || formatPhone(item.customerPhone) || 'Customer';
}

function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '#';
  if (/^\d/.test(words[0])) return words[words.length - 1].slice(-2);
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

function avatarColour(key) {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

function avatar(item) {
  return `<span class="avatar" style="background:${avatarColour(item.customerPhone)}" aria-hidden="true">${escapeHtml(initials(displayName(item)))}</span>`;
}

function ago(dateStr) {
  if (!dateStr) return '';
  const mins = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function listTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  if (now - d < 6 * 24 * 60 * 60 * 1000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function dayLabel(d) {
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

function clock(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function money(amount, currency) {
  const n = Number(amount) || 0;
  if (!currency || currency === 'INR') return '₹' + Math.round(n).toLocaleString('en-IN');
  return `${n.toLocaleString()} ${currency}`;
}

let toastTimer = null;
function toast(message) {
  const t = el('toast');
  t.textContent = message;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function fillIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (!node.firstChild) node.innerHTML = icon(node.dataset.icon);
  }
}

function ticketLabel(ticket) {
  return `Ticket #${ticket.ticketNumber} · ${ISSUE_LABELS[ticket.issueType] || ticket.issueType}`;
}

// The one label a chat shows in the list, most important first.
function chatLabel(c) {
  if (c.ticket) {
    if (c.ticket.overdue) return { text: `${ticketLabel(c.ticket)} · Overdue`, cls: 'pill-red' };
    if (c.ticket.status === 'open') return { text: ticketLabel(c.ticket), cls: 'pill-red' };
    return { text: `${ticketLabel(c.ticket)} · You replied`, cls: 'pill-amber' };
  }
  if (c.needsReply) return { text: 'Needs reply', cls: 'pill-clay' };
  if (c.last && c.last.autoAck === 'ai_answer') return { text: 'AI answered', cls: 'pill-green' };
  if (c.last && c.last.autoAck === 'order_status') return { text: 'Order status sent', cls: 'pill-green' };
  return null;
}

function tickHtml(status) {
  if (status === 'read') return `<span class="tick read" title="Read">${TICK_TWO}</span>`;
  if (status === 'delivered') return `<span class="tick" title="Delivered">${TICK_TWO}</span>`;
  if (status === 'sent') return `<span class="tick" title="Sent">${TICK_ONE}</span>`;
  return '';
}

// ---------- Login ----------
function showLogin() {
  el('login-screen').classList.remove('hidden');
  el('shell').classList.add('hidden');
  el('login-input').focus();
}

function logout() {
  localStorage.removeItem(API_KEY_STORAGE);
  apiKey = '';
  showLogin();
}

async function doLogin() {
  const value = el('login-input').value.trim();
  if (!value) return;
  apiKey = value;
  el('login-error').classList.add('hidden');
  try {
    await api('/api/config');
    localStorage.setItem(API_KEY_STORAGE, apiKey);
    start();
  } catch (err) {
    el('login-error').classList.remove('hidden');
  }
}

el('login-button').addEventListener('click', doLogin);
el('login-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
el('logout-button').addEventListener('click', () => {
  if (confirm('Log out on this device? You will need the access code again.')) logout();
});

async function start() {
  el('login-screen').classList.add('hidden');
  el('shell').classList.remove('hidden');
  try {
    config = { ...config, ...(await api('/api/config')) };
  } catch (err) {
    /* keep defaults */
  }
  for (const node of document.querySelectorAll('.test-only')) node.classList.toggle('hidden', !config.testMode);
  if (config.founderName) {
    el('me-name').textContent = config.founderName;
    el('me-avatar').textContent = initials(config.founderName);
  }
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/home');
  else onRoute();
}

// ---------- Routing ----------
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = ['home', 'inbox', 'test'].includes(parts[0]) ? parts[0] : 'home';
  if (view === 'test' && !config.testMode) return { view: 'home', id: null, pane: 'list' };
  if (view !== 'inbox') return { view, id: null, pane: 'list' };
  const id = /^[a-f0-9]{24}$/.test(parts[1] || '') ? parts[1] : null;
  return { view, id, pane: id ? (parts[2] === 'customer' ? 'customer' : 'thread') : 'list' };
}

function onRoute() {
  const prev = route;
  route = parseRoute();
  document.body.dataset.view = route.view;
  document.body.dataset.pane = route.pane;
  for (const v of ['home', 'inbox', 'test']) el(`view-${v}`).classList.toggle('hidden', v !== route.view);
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === route.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  if (route.view === 'home') return loadHome();
  if (route.view === 'test') return renderTest();

  if (!inbox.loaded || prev.view !== 'inbox') loadInbox();
  else renderChatList();
  if (route.id && (!thread || thread.id !== route.id)) openThread(route.id);
  if (!route.id) closeThread();
}
window.addEventListener('hashchange', onRoute);

// ---------- Home ----------
function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (config.founderName || '').split(' ')[0];
  return first ? `${part}, ${first}` : part;
}

async function loadHome() {
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
  if (route.view !== 'home') return;

  const k = d.kpis;
  const needCount = k.tickets.waitingOnYou + k.chatsWaiting.count;
  const date = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long' });
  const attention = d.attention.map(attentionRow).join('');
  const auto = d.automationsToday;
  const aiOn = config.ai && config.ai.enabled;

  view.innerHTML = `
    <div class="home">
      <header class="home-head">
        <div class="row"><span class="eyebrow">${escapeHtml(date)}</span>${config.testMode ? '<span class="pill pill-amber">Test mode</span>' : ''}</div>
        <h1 class="page-title">${escapeHtml(greeting())}</h1>
        <p>${needCount === 0 ? 'All caught up. Nothing is waiting for you.' : `${needCount} ${needCount === 1 ? 'thing needs' : 'things need'} you.`}</p>
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
        <a class="kpi" href="#/inbox" data-filter-link="all">
          <span class="kpi-label">Messages today</span>
          <span class="kpi-value">${k.messagesToday.count}</span>
          <span class="kpi-sub">from ${k.messagesToday.customers} customer${k.messagesToday.customers === 1 ? '' : 's'}</span>
        </a>
      </section>

      <div class="home-grid">
        <section class="card" aria-labelledby="attn-title">
          <h2 id="attn-title">Needs your attention</h2>
          ${attention || `<div class="all-clear"><span class="ico">${icon('check')}</span>Nothing waiting. New problems and questions show up here.</div>`}
        </section>
        <div style="display:flex;flex-direction:column;gap:20px">
          <section class="card" aria-labelledby="auto-title">
            <h2 id="auto-title">Automations today</h2>
            <div class="auto-row"><span>Order status answered</span><b>${auto.orderStatus}</b></div>
            <div class="auto-row"><span>Questions answered by AI</span><b>${auto.aiAnswers}</b></div>
            <div class="auto-row"><span>Instant acknowledgments</span><b>${auto.acknowledgments}</b></div>
            <div class="auto-row"><span>Tickets opened</span><b>${auto.ticketsOpened}</b></div>
            <p class="card-note" style="margin-top:8px">${aiOn ? `AI answers are on (${escapeHtml(config.ai.model || config.ai.provider)}).` : 'AI answers are off. Add your AI key in Render (AI_API_KEY) to turn them on.'}</p>
          </section>
          ${config.testMode ? `
          <section class="card dark-card">
            <h2>Try it out</h2>
            <p>Pretend to be a customer: send a message, a photo or a voice note and watch what the inbox does. Nothing is sent on WhatsApp.</p>
            <a class="btn" href="#/test">Open Test</a>
          </section>` : ''}
        </div>
      </div>
    </div>`;

  for (const a of view.querySelectorAll('[data-filter-link]')) {
    a.addEventListener('click', () => setFilter(a.dataset.filterLink, false));
  }
}

function attentionRow(a) {
  let title;
  let pill;
  if (a.kind === 'needs_reply') {
    title = a.preview || 'New message';
    pill = '<span class="pill pill-clay">Needs reply</span>';
  } else {
    title = `Ticket #${a.ticketNumber} · ${ISSUE_LABELS[a.issueType] || a.issueType}`;
    pill = a.kind === 'overdue' ? '<span class="pill pill-red">Overdue</span>' : '<span class="pill pill-amber">New ticket</span>';
  }
  return `
    <a class="attention-row" href="#/inbox/${a.conversationId}">
      ${avatar(a)}
      <span class="attention-main">
        <span class="attention-title">${escapeHtml(title)}</span>
        <span class="attention-sub">${escapeHtml(displayName(a))} · waiting ${escapeHtml(ago(a.since))}</span>
      </span>
      ${pill}
    </a>`;
}

function setInboxCount(n) {
  for (const node of document.querySelectorAll('[data-count="inbox"]')) {
    node.textContent = n > 99 ? '99+' : String(n);
    node.classList.toggle('hidden', !n);
  }
}

// ---------- Inbox list ----------
function setFilter(filter, reload = true) {
  inbox.filter = filter;
  for (const b of el('filter-chips').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  }
  if (reload) loadInbox();
  else inbox.loaded = false;
}

for (const b of el('filter-chips').querySelectorAll('button')) {
  b.addEventListener('click', () => setFilter(b.dataset.filter));
}

let searchTimer = null;
el('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    inbox.q = e.target.value.trim();
    loadInbox();
  }, 250);
});

let inboxRequest = 0;
async function loadInbox() {
  const mine = ++inboxRequest;
  if (!inbox.loaded) el('chat-list').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const params = new URLSearchParams({ filter: inbox.filter });
    if (inbox.q) params.set('q', inbox.q);
    const data = await api(`/api/inbox?${params}`);
    if (mine !== inboxRequest) return; // a newer search already answered
    inbox.items = data.items;
    inbox.counts = data.counts;
    inbox.loaded = true;
    setInboxCount(data.counts.needs_reply);
    renderChatList();
  } catch (err) {
    if (mine === inboxRequest && !inbox.loaded) {
      el('chat-list').innerHTML = `<div class="empty"><b>Couldn't load chats</b>${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderChatList() {
  for (const b of el('filter-chips').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === inbox.filter));
    const n = inbox.counts ? inbox.counts[b.dataset.filter] : '';
    b.querySelector('span').textContent = n === '' || n == null ? '' : n;
  }
  const list = el('chat-list');
  if (inbox.items.length === 0) {
    const msg = inbox.q
      ? `<b>No chats match "${escapeHtml(inbox.q)}"</b>Try a name, part of a number, a tag or a ticket number.`
      : inbox.filter === 'needs_reply'
      ? '<b>All caught up</b>No one is waiting for a reply.'
      : inbox.filter === 'tickets'
      ? '<b>No open tickets</b>Problems customers report show up here.'
      : '<b>No chats yet</b>Customer messages show up here.';
    list.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  list.innerHTML = inbox.items
    .map((c) => {
      const label = chatLabel(c);
      // Ticks only when the preview is our own reply (quiet acknowledgments
      // leave the customer's message as the preview).
      const ownPreview = c.last && c.last.direction === 'outbound' && (c.last.sentByFounder || ['ai_answer', 'order_status'].includes(c.last.autoAck));
      return `
        <a class="chat-item${c.needsReply ? ' needs' : ''}" href="#/inbox/${c._id}" aria-current="${route.id === c._id}">
          ${avatar(c)}
          <span class="chat-main">
            <span class="chat-row"><span class="chat-name">${escapeHtml(displayName(c))}</span><span class="chat-time">${escapeHtml(listTime(c.lastMessageAt))}</span></span>
            <span class="chat-preview">${ownPreview ? tickHtml(c.last.status) : ''}<span>${escapeHtml(c.lastMessagePreview)}</span></span>
            <span class="chat-labels">${label ? `<span class="pill ${label.cls}">${escapeHtml(label.text)}</span>` : ''}${c.needsReply ? '<span class="dot" aria-label="Needs reply"></span>' : ''}</span>
          </span>
        </a>`;
    })
    .join('');
}

// ---------- One chat ----------
let threadRequest = 0;
async function openThread(id) {
  const mine = ++threadRequest;
  const changed = !thread || thread.id !== id;
  el('thread-empty').classList.add('hidden');
  el('thread').classList.remove('hidden');
  if (changed) {
    thread = { id, conversation: null, messages: [] };
    profile = null;
    el('thread-who').innerHTML = '';
    el('thread-strip').innerHTML = '';
    el('messages').innerHTML = '<div class="empty">Loading…</div>';
    el('customer-body').innerHTML = '<div class="empty">Loading…</div>';
    el('composer-input').value = '';
    renderChatList();
  }
  let data;
  try {
    data = await api(`/api/conversations/${id}`);
  } catch (err) {
    if (mine === threadRequest) el('messages').innerHTML = `<div class="empty"><b>Couldn't load this chat</b>${escapeHtml(err.message)}</div>`;
    return;
  }
  if (mine !== threadRequest || !thread || thread.id !== id) return;
  // Only redraw messages when something changed (a new message or a tick),
  // so a playing voice note or the scroll position isn't disturbed.
  const sig = (list) => list.map((m) => `${m._id}:${m.status || ''}`).join('|');
  const messagesChanged = changed || sig(thread.messages) !== sig(data.messages);
  thread.conversation = data.conversation;
  thread.messages = data.messages;
  renderThreadHead();
  if (changed || !el('thread-strip').querySelector('.issue-picker')) renderStrip();
  // Composer first: it can change the height of the message area, which must
  // be final before scrolling to the newest message.
  renderComposer();
  if (messagesChanged) renderMessages(changed);
  if (changed) loadProfile(data.conversation.customerPhone);
}

function closeThread() {
  thread = null;
  profile = null;
  threadRequest++;
  el('thread').classList.add('hidden');
  el('thread-empty').classList.remove('hidden');
  el('customer-body').innerHTML = '<div class="empty">Pick a chat to see who it is.</div>';
}

function customerPath() {
  return `#/inbox/${thread.id}/customer`;
}

function renderThreadHead() {
  const c = thread.conversation;
  const status = profile && profile.status && profile.status !== 'new' ? profile.statusLabel : '';
  const sub = c.ticket ? ticketLabel(c.ticket) : formatPhone(c.customerPhone);
  el('thread-who').innerHTML = `
    ${avatar(c)}
    <span class="who-text">
      <span class="who-name"><span>${escapeHtml(displayName(c))}</span>${status ? `<span class="pill ${profile.status === 'vip' ? 'pill-vip' : 'pill-green'}">${escapeHtml(status)}</span>` : ''}</span>
      <span class="who-sub">${escapeHtml(sub)}</span>
    </span>`;
}

el('thread-who').addEventListener('click', () => {
  if (thread) location.hash = customerPath();
});
el('profile-btn').addEventListener('click', () => {
  if (thread) location.hash = customerPath();
});
el('customer-close').addEventListener('click', () => {
  if (thread) location.hash = `#/inbox/${thread.id}`;
  else location.hash = '#/inbox';
});

function windowState(c) {
  if (!c.windowClosesAt) return { cls: 'closed', text: 'Reply window closed', open: false };
  const left = new Date(c.windowClosesAt).getTime() - Date.now();
  if (left <= 0) return { cls: 'closed', text: 'Reply window closed', open: false };
  const hours = Math.floor(left / 3600000);
  const mins = Math.max(1, Math.round((left % 3600000) / 60000));
  const text = hours >= 1 ? `Reply window: ${hours}h left` : `Reply window: ${mins} min left`;
  return { cls: hours < 4 ? 'soon' : 'ok', text, open: true };
}

function renderStrip() {
  const c = thread.conversation;
  const w = windowState(c);
  const action = c.ticket
    ? '<button type="button" class="btn btn-small btn-ok" id="resolve-btn">Mark resolved</button>'
    : '<button type="button" class="btn btn-small" id="flag-btn">Flag as an issue</button>';
  el('thread-strip').innerHTML = `
    <span class="window ${w.cls}" title="WhatsApp lets you reply freely for 24 hours after the customer's last message"><span class="ico">${icon('clock')}</span>${escapeHtml(w.text)}</span>
    <span class="strip-actions">${action}</span>`;
  const resolve = el('resolve-btn');
  if (resolve) resolve.addEventListener('click', resolveTicket);
  const flag = el('flag-btn');
  if (flag) flag.addEventListener('click', showIssuePicker);
}

async function resolveTicket() {
  const t = thread.conversation.ticket;
  if (!confirm(`Mark ticket #${t.ticketNumber} as resolved?`)) return;
  try {
    await api(`/api/tickets/${t._id}/resolve`, { method: 'POST' });
    toast(`Ticket #${t.ticketNumber} resolved`);
    await openThread(thread.id);
    loadInbox();
    if (profile) loadProfile(thread.conversation.customerPhone);
  } catch (err) {
    toast(`Couldn't resolve: ${err.message}`);
  }
}

function showIssuePicker() {
  const strip = el('thread-strip');
  const picker = document.createElement('div');
  picker.className = 'issue-picker';
  picker.innerHTML =
    '<span class="label">What kind of issue is this?</span>' +
    ISSUE_TYPES.map((t) => `<button type="button" class="btn btn-small" data-issue="${t}">${escapeHtml(ISSUE_LABELS[t])}</button>`).join('') +
    '<button type="button" class="btn btn-small" data-issue="">Cancel</button>';
  strip.querySelector('.issue-picker')?.remove();
  strip.appendChild(picker);
  for (const b of picker.querySelectorAll('button')) {
    b.addEventListener('click', async () => {
      if (!b.dataset.issue) return picker.remove();
      try {
        const t = await api(`/api/conversations/${thread.id}/flag-ticket`, {
          method: 'POST',
          body: JSON.stringify({ issueType: b.dataset.issue }),
        });
        toast(`Ticket #${t.ticketNumber} opened`);
        await openThread(thread.id);
        loadInbox();
      } catch (err) {
        toast(`Couldn't open a ticket: ${err.message}`);
      }
    });
  }
}

function renderMessages(scrollToEnd) {
  const box = el('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (thread.messages.length === 0) {
    box.innerHTML = '<div class="empty">No messages yet.</div>';
    return;
  }
  let lastDay = null;
  const parts = [];
  for (const m of thread.messages) {
    const d = new Date(m.createdAt);
    const key = d.toDateString();
    if (key !== lastDay) {
      parts.push(`<div class="day">${escapeHtml(dayLabel(d))}</div>`);
      lastDay = key;
    }
    parts.push(messageHtml(m));
  }
  box.innerHTML = parts.join('');
  hydrateMedia(box);
  if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
}

function messageHtml(m) {
  const out = m.direction === 'outbound';
  const label = out && m.autoAck ? AUTO_LABELS[m.autoAck] || 'Auto-reply' : '';
  const hasMedia = !!m.media;
  const caption = hasMedia ? (/^\[(photo|audio|video|document|sticker)\]$/.test(m.body) ? '' : m.body) : m.body;
  const failed = m.status === 'failed'
    ? `<div class="meta failed">Not delivered${m.statusError ? `: ${escapeHtml(m.statusError)}` : ''}</div>`
    : '';
  return `
    <div class="bubble ${out ? 'out' : 'in'}${hasMedia ? ' media' : ''}">
      ${label ? `<span class="auto-label">${escapeHtml(label)}</span>` : ''}
      ${hasMedia ? mediaHtml(m) : ''}
      ${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ''}
      <div class="meta">${escapeHtml(clock(m.createdAt))}${out ? tickHtml(m.status) : ''}</div>
      ${failed}
    </div>`;
}

function mediaHtml(m) {
  const id = escapeHtml(m._id);
  if (m.type === 'image') {
    return `<button type="button" class="photo" data-photo="${id}" aria-label="Open photo"><span class="loading">Loading photo…</span></button>`;
  }
  if (m.type === 'sticker') return `<img class="sticker" data-sticker="${id}" alt="Sticker" />`;
  if (m.type === 'audio') {
    return `<div class="voice" data-voice="${id}">
      <button type="button" class="play" aria-label="Play voice message"><span class="ico">${icon('play')}</span></button>
      <span class="track" role="progressbar" aria-label="Voice message progress"><span class="fill"></span></span>
      <span class="time">${m.media.voice ? 'Voice' : 'Audio'}</span>
    </div>`;
  }
  if (m.type === 'video') return `<video class="video" data-video="${id}" controls preload="none"></video>`;
  const name = m.media.filename || 'File';
  return `<button type="button" class="file" data-file="${id}" data-name="${escapeHtml(name)}"><span class="ico">${icon('file')}</span><span>${escapeHtml(name)}</span><span class="ico">${icon('download')}</span></button>`;
}

// Media is fetched with the access code, so it's loaded as a blob and shown
// from a local object URL. Cached per message for the session.
async function mediaUrl(id) {
  if (mediaUrls.has(id)) return mediaUrls.get(id);
  const res = await fetch(`/api/media/${id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(res.status === 404 ? 'No longer available' : `Error ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  mediaUrls.set(id, url);
  return url;
}

function hydrateMedia(root) {
  for (const btn of root.querySelectorAll('[data-photo]')) {
    const id = btn.dataset.photo;
    mediaUrl(id)
      .then((url) => {
        btn.innerHTML = `<img src="${url}" alt="Photo from customer" />`;
        btn.addEventListener('click', () => openLightbox(url));
      })
      .catch((err) => {
        btn.innerHTML = `<span class="loading">Photo: ${escapeHtml(err.message)}</span>`;
        btn.style.cursor = 'default';
      });
  }
  for (const img of root.querySelectorAll('[data-sticker]')) {
    mediaUrl(img.dataset.sticker).then((url) => (img.src = url)).catch(() => (img.alt = 'Sticker (unavailable)'));
  }
  for (const video of root.querySelectorAll('[data-video]')) {
    mediaUrl(video.dataset.video).then((url) => (video.src = url)).catch(() => video.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Video no longer available' })));
  }
  for (const box of root.querySelectorAll('[data-voice]')) setupVoice(box);
  for (const btn of root.querySelectorAll('[data-file]')) {
    btn.addEventListener('click', () => downloadFile(btn.dataset.file, btn.dataset.name));
  }
}

let playing = null;
function setupVoice(box) {
  const id = box.dataset.voice;
  const btn = box.querySelector('.play');
  const fill = box.querySelector('.fill');
  const time = box.querySelector('.time');
  const track = box.querySelector('.track');
  let audio = null;
  const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
  const setIcon = (name, label) => {
    btn.innerHTML = `<span class="ico">${icon(name)}</span>`;
    btn.setAttribute('aria-label', label);
  };

  async function ensure() {
    if (audio) return audio;
    time.textContent = '…';
    const url = await mediaUrl(id);
    audio = new Audio(url);
    audio.addEventListener('loadedmetadata', () => (time.textContent = fmt(audio.duration)));
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      time.textContent = fmt(audio.currentTime || audio.duration);
    });
    audio.addEventListener('ended', () => {
      setIcon('play', 'Play voice message');
      fill.style.width = '0';
      time.textContent = fmt(audio.duration);
    });
    audio.addEventListener('pause', () => setIcon('play', 'Play voice message'));
    audio.addEventListener('play', () => setIcon('pause', 'Pause voice message'));
    return audio;
  }

  btn.addEventListener('click', async () => {
    try {
      const a = await ensure();
      if (a.paused) {
        if (playing && playing !== a) playing.pause();
        playing = a;
        await a.play();
      } else {
        a.pause();
      }
    } catch (err) {
      // e.g. an older iPhone that can't play WhatsApp's voice format.
      time.textContent = '';
      box.innerHTML = `<button type="button" class="file"><span class="ico">${icon('download')}</span><span>Can't play here. Download</span></button>`;
      box.querySelector('button').addEventListener('click', () => downloadFile(id, 'voice-message.ogg'));
    }
  });
  track.addEventListener('click', async (e) => {
    const a = await ensure().catch(() => null);
    if (!a || !a.duration) return;
    const r = track.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
  });
}

async function downloadFile(id, name) {
  try {
    const url = await mediaUrl(id);
    // Re-wrap as a plain download so a customer's file never opens as a page here.
    const blob = await (await fetch(url)).blob();
    const safe = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: safe, download: name || 'file' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(safe), 10000);
  } catch (err) {
    toast(`Couldn't download: ${err.message}`);
  }
}

function openLightbox(url) {
  el('lightbox-img').src = url;
  el('lightbox').classList.remove('hidden');
  el('lightbox-close').focus();
}
function closeLightbox() {
  el('lightbox').classList.add('hidden');
  el('lightbox-img').removeAttribute('src');
}
el('lightbox-close').addEventListener('click', closeLightbox);
el('lightbox').addEventListener('click', (e) => {
  if (e.target === el('lightbox')) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('lightbox').classList.contains('hidden')) closeLightbox();
});

// ---------- Composer ----------
function renderComposer() {
  const w = windowState(thread.conversation);
  el('composer').classList.toggle('hidden', !w.open);
  el('quick-replies').classList.toggle('hidden', !w.open);
  const closed = el('composer-closed');
  closed.classList.toggle('hidden', w.open);
  if (!w.open) {
    closed.innerHTML =
      "<b>You can't reply to this chat right now.</b>WhatsApp only allows free replies for 24 hours after the customer's last message. It opens again as soon as they message you.";
  }
  const qr = el('quick-replies');
  if (!qr.childElementCount) {
    for (const text of QUICK_REPLIES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => {
        const input = el('composer-input');
        input.value = text;
        autosize();
        input.focus();
      });
      qr.appendChild(b);
    }
  }
}

function autosize() {
  const input = el('composer-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
}
el('composer-input').addEventListener('input', autosize);
el('composer-input').addEventListener('keydown', (e) => {
  // Enter sends on a computer; on phones Enter adds a new line and the button sends.
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) {
    e.preventDefault();
    sendReply();
  }
});
el('composer-send').addEventListener('click', sendReply);

let sending = false;
async function sendReply() {
  const input = el('composer-input');
  const body = input.value.trim();
  if (!body || !thread || sending) return;
  sending = true;
  el('composer-send').disabled = true;
  try {
    const message = await api(`/api/conversations/${thread.id}/reply`, { method: 'POST', body: JSON.stringify({ body }) });
    input.value = '';
    autosize();
    thread.messages.push(message);
    renderMessages(true);
    openThread(thread.id);
    loadInbox();
  } catch (err) {
    toast(`Not sent: ${err.message}`);
  } finally {
    sending = false;
    el('composer-send').disabled = false;
  }
}

// ---------- Customer panel ----------
async function loadProfile(phone) {
  const forId = thread && thread.id;
  try {
    const p = await api(`/api/customers/${phone}`);
    if (!thread || thread.id !== forId) return;
    profile = p;
    renderThreadHead();
    renderProfile();
  } catch (err) {
    if (thread && thread.id === forId) {
      el('customer-body').innerHTML = `<div class="empty"><b>Couldn't load this customer</b>${escapeHtml(err.message)}</div>`;
    }
  }
}

function fulfilLabel(status) {
  const map = {
    UNFULFILLED: ['Not shipped yet', 'pill-amber'],
    PARTIALLY_FULFILLED: ['Partly shipped', 'pill-amber'],
    FULFILLED: ['Shipped', 'pill-green'],
    RESTOCKED: ['Returned', 'pill-red'],
    IN_PROGRESS: ['Packing', 'pill-amber'],
    ON_HOLD: ['On hold', 'pill-red'],
    SCHEDULED: ['Scheduled', 'pill-amber'],
  };
  return map[status] || ['Processing', 'pill-amber'];
}

function renderProfile() {
  const p = profile;
  const c = thread.conversation;
  const s = p.shopify || { found: false };
  const name = p.name || displayName(c);
  const statusPill = p.status === 'vip' ? 'pill-vip' : p.status === 'returning' ? 'pill-green' : '';
  const orders = (s.orders || [])
    .map((o) => {
      const [label, cls] = fulfilLabel(o.fulfillmentStatus);
      return `<div class="box-row"><span><b>${escapeHtml(o.name)}</b><div class="sub">${escapeHtml(new Date(o.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))} · ${money(o.total, s.currency)}</div></span><span class="pill ${cls}">${escapeHtml(label)}</span></div>`;
    })
    .join('');
  const tickets = (p.tickets || [])
    .map((t) => {
      const [label, cls] = t.status === 'resolved' ? ['Resolved', 'pill-green'] : t.status === 'open' ? ['Open', 'pill-red'] : ['You replied', 'pill-amber'];
      return `<div class="box-row"><span>#${t.ticketNumber} · ${escapeHtml(ISSUE_LABELS[t.issueType] || t.issueType)}</span><span class="pill ${cls}">${label}</span></div>`;
    })
    .join('');

  el('customer-body').innerHTML = `
    <div class="cust-top">
      ${avatar({ customerPhone: c.customerPhone, customerName: name })}
      <div>
        <h2 class="cust-name">${escapeHtml(name)}</h2>
        <div class="cust-phone">${escapeHtml(formatPhone(p.phone))}</div>
        <span class="pill ${statusPill}" style="margin-top:4px">${escapeHtml(p.statusLabel || 'New')}</span>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b>${s.found ? s.ordersCount : '0'}</b><span>orders</span></div>
      <div class="stat"><b>${s.found ? money(s.totalSpent, s.currency) : '₹0'}</b><span>spent</span></div>
      <div class="stat"><b>${s.lastOrderAt ? escapeHtml(ago(s.lastOrderAt)) : '—'}</b><span>last order</span></div>
    </div>
    <section>
      <h3 class="section-title">Orders</h3>
      <div class="box">${s.error ? '<div class="box-empty">Couldn\'t reach Shopify right now.</div>' : orders || '<div class="box-empty">No orders for this number.</div>'}</div>
    </section>
    <section>
      <h3 class="section-title">Tags</h3>
      <div class="tags" id="tags"></div>
    </section>
    <section>
      <h3 class="section-title">Tickets</h3>
      <div class="box">${tickets || '<div class="box-empty">No problems reported.</div>'}</div>
    </section>
    <section>
      <h3 class="section-title">Your note</h3>
      <textarea class="note" id="note" placeholder="e.g. Prefers less spicy · orders for her parents every month" aria-label="Private note about this customer">${escapeHtml(p.notes || '')}</textarea>
      <div class="note-row"><button type="button" class="btn btn-small" id="note-save">Save note</button><span id="note-saved" class="hidden">Saved</span></div>
    </section>
    <label class="optin">
      <span>Opted in to offers on WhatsApp<small>Only opted-in customers get campaigns</small></span>
      <span class="switch"><input type="checkbox" id="optin" ${p.optedInMarketing ? 'checked' : ''} /><span class="track"></span></span>
    </label>`;

  renderTags();
  const note = el('note');
  let savedNote = p.notes || '';
  const saveNote = async () => {
    if (note.value === savedNote) return;
    try {
      await patchCustomer({ notes: note.value });
      savedNote = note.value;
      el('note-saved').classList.remove('hidden');
      setTimeout(() => el('note-saved') && el('note-saved').classList.add('hidden'), 2000);
    } catch (err) {
      toast(`Note not saved: ${err.message}`);
    }
  };
  el('note-save').addEventListener('click', saveNote);
  note.addEventListener('blur', saveNote);
  el('optin').addEventListener('change', async (e) => {
    try {
      await patchCustomer({ optedInMarketing: e.target.checked });
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`Not updated: ${err.message}`);
    }
  });
}

async function patchCustomer(update) {
  const phone = profile.phone;
  const res = await api(`/api/customers/${phone}`, { method: 'PATCH', body: JSON.stringify(update) });
  if (profile && profile.phone === phone) Object.assign(profile, res);
  return res;
}

function renderTags() {
  const box = el('tags');
  if (!box) return;
  box.innerHTML =
    (profile.tags || [])
      .map((t) => `<span class="tag">${escapeHtml(t)}<button type="button" data-remove="${escapeHtml(t)}" aria-label="Remove tag ${escapeHtml(t)}"><span class="ico">${icon('close')}</span></button></span>`)
      .join('') + '<button type="button" class="add-tag" id="add-tag">+ Add tag</button>';

  for (const b of box.querySelectorAll('[data-remove]')) {
    b.addEventListener('click', () => saveTags(profile.tags.filter((t) => t !== b.dataset.remove)));
  }
  el('add-tag').addEventListener('click', async () => {
    const input = document.createElement('input');
    input.className = 'tag-input';
    input.placeholder = 'e.g. Jain, Monthly';
    input.setAttribute('aria-label', 'New tag');
    input.setAttribute('list', 'tag-suggestions');
    input.maxLength = 30;
    el('add-tag').replaceWith(input);
    input.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v) saveTags([...(profile.tags || []), v]);
      else renderTags();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        done = true;
        renderTags();
      }
    });
    input.addEventListener('blur', commit);
    try {
      knownTags = await api('/api/tags');
      let list = el('tag-suggestions');
      if (!list) {
        list = document.createElement('datalist');
        list.id = 'tag-suggestions';
        document.body.appendChild(list);
      }
      list.innerHTML = knownTags.map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
    } catch (err) {
      /* suggestions are optional */
    }
  });
}

async function saveTags(tags) {
  try {
    await patchCustomer({ tags });
    renderTags();
    loadInbox();
  } catch (err) {
    toast(`Tags not saved: ${err.message}`);
    renderTags();
  }
}

// ---------- Test mode: pretend to be a customer ----------
const TEST_SAMPLES = [
  ['Order status', 'Hi, where is my order?'],
  ['Damaged', 'My order arrived but one container was broken and leaking'],
  ['Missing item', 'One item is missing from my box'],
  ['Wrong item', 'You sent me the wrong item'],
  ['Refund', 'I want a refund for my last order'],
  ['Late delivery', "It's been 5 days and my order is still not delivered yet"],
  ['Bad taste', 'The dal tasted bad and was not fresh'],
  ['Payment', "Money deducted but I didn't get any order confirmation"],
  ['Hi', 'Hi'],
  ['Question', 'Do you have Jain options without onion and garlic?'],
  ['Bulk order', 'I want to place a bulk order for a family function'],
  ['Delivery area', 'Do you deliver to Pune?'],
  ['Compliment', 'Loved the food, thank you!'],
  ['Ok thanks', 'ok thanks'],
  ['Free delivery?', 'Free delivery kitna order pe milta hai?'],
  ['How to heat', 'How do I heat it? Can I use a microwave?'],
];
let testCustomers = null;

async function renderTest() {
  const view = el('view-test');
  if (view.querySelector('#test-send')) return;
  const aiOn = config.ai && config.ai.enabled;
  view.innerHTML = `
    <div class="test">
      <header class="home-head">
        <h1 class="page-title">Test</h1>
        <p>Pretend a customer just messaged you on WhatsApp and see exactly what your inbox does. Nothing is sent to anyone.</p>
      </header>
      <p class="card-note">${aiOn ? `AI answers are <b>on</b> (${escapeHtml(config.ai.model || config.ai.provider)}).` : 'AI answers are <b>off</b>: add your AI key in Render (AI_API_KEY) to turn them on. Until then, general questions get an acknowledgment.'}</p>
      <div class="field">
        <label for="test-customer">Customer</label>
        <select id="test-customer"><option>Loading your Shopify customers…</option></select>
      </div>
      <div id="test-custom" class="field hidden">
        <input id="test-phone" inputmode="numeric" placeholder="Phone with country code, e.g. 919876543210" aria-label="Phone number" />
        <input id="test-name" placeholder="Their name (optional)" aria-label="Name" />
      </div>
      <div class="field">
        <label for="test-text">Their message</label>
        <div class="test-chips" id="test-chips"></div>
        <textarea id="test-text" rows="3" placeholder="Type what the customer says, or tap an example above. For a photo, this becomes its caption."></textarea>
      </div>
      <div class="test-actions">
        <button type="button" class="btn btn-primary" id="test-send">Send as customer</button>
        <button type="button" class="btn" id="test-photo">Send a photo</button>
        <button type="button" class="btn" id="test-voice">Send a voice note</button>
      </div>
      <div id="test-result"></div>
    </div>`;

  for (const [label, text] of TEST_SAMPLES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = label;
    chip.addEventListener('click', () => (el('test-text').value = text));
    el('test-chips').appendChild(chip);
  }
  el('test-send').addEventListener('click', () => sendTest('text'));
  el('test-photo').addEventListener('click', () => sendTest('image'));
  el('test-voice').addEventListener('click', () => sendTest('audio'));

  if (!testCustomers) {
    try {
      testCustomers = await api('/api/test/customers');
    } catch (err) {
      testCustomers = [];
    }
  }
  const select = el('test-customer');
  if (!select) return;
  select.innerHTML =
    testCustomers
      .map((c, i) => `<option value="${i}">${escapeHtml(c.name || 'Customer')} · …${escapeHtml(c.phone.slice(-4))} · ${c.ordersCount} order${c.ordersCount === 1 ? '' : 's'}</option>`)
      .join('') + '<option value="custom">Someone else (type a number)</option>';
  const sync = () => el('test-custom').classList.toggle('hidden', select.value !== 'custom');
  select.addEventListener('change', sync);
  sync();
}

async function sendTest(type) {
  const choice = el('test-customer').value;
  const customer = choice === 'custom' ? null : testCustomers[Number(choice)];
  const body = {
    type,
    phone: customer ? customer.phone : el('test-phone').value,
    name: customer ? customer.name : el('test-name').value,
    text: type === 'audio' ? '' : el('test-text').value,
  };
  const buttons = ['test-send', 'test-photo', 'test-voice'].map(el);
  buttons.forEach((b) => (b.disabled = true));
  el('test-result').innerHTML = '<div class="result">Sending…</div>';
  try {
    const r = await api('/api/test/simulate', { method: 'POST', body: JSON.stringify(body) });
    renderTestResult(r);
    if (type !== 'audio') el('test-text').value = '';
    inbox.loaded = false;
  } catch (err) {
    el('test-result').innerHTML = `<div class="result error">${escapeHtml(err.message)}</div>`;
  } finally {
    buttons.forEach((b) => b && (b.disabled = false));
  }
}

function renderTestResult(r) {
  const issue = ISSUE_LABELS[r.issueType] || r.issueType;
  const outcome = {
    auto_answered: 'Answered automatically from Shopify. No work for you.',
    ticket_created: `Ticket #${r.ticketNumber} opened (${issue}). It's waiting in your Inbox.`,
    added_to_ticket: `Added to their open ticket #${r.ticketNumber}.`,
    ai_answered: 'Answered automatically by AI from your website info. No work for you.',
    acknowledged: 'Acknowledged automatically. It is waiting in your Inbox for you to reply.',
    chat: 'Added to your Inbox for you to reply.',
  }[r.outcome];
  const replies = r.replies.length
    ? '<div class="would">The customer would receive</div>' + r.replies.map((t) => `<div class="reply">${escapeHtml(t)}</div>`).join('')
    : '<div class="would">No automatic reply</div>';
  el('test-result').innerHTML = `
    <div class="result">
      <div class="outcome">${escapeHtml(outcome)}</div>
      ${replies}
      <a class="btn btn-dark" style="align-self:flex-start" href="#/inbox/${r.conversationId}">Open the chat</a>
    </div>`;
}

// ---------- Keep things fresh ----------
setInterval(() => {
  if (!apiKey || document.hidden || el('shell').classList.contains('hidden')) return;
  if (route.view === 'home') loadHome();
  if (route.view === 'inbox') {
    loadInbox();
    // Don't redraw a chat while the founder is typing a tag or note.
    const active = document.activeElement;
    const editing = active && (active.id === 'note' || active.classList.contains('tag-input'));
    if (thread && !editing) openThread(thread.id);
  }
}, POLL_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && apiKey && route.view === 'inbox' && thread) openThread(thread.id);
});

// ---------- Boot ----------
fillIcons();
if (apiKey) start();
else showLogin();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}
