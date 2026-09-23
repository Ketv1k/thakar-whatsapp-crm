// Founder Inbox - single-page vanilla JS app. No build step on purpose:
// this is meant to be easy to tweak from a phone browser's dev tools if
// needed, not a project to maintain a bundler for.

const API_KEY_STORAGE = 'thakar_inbox_api_key';
const QUICK_REPLIES = [
  "Thanks, we're on it!",
  'Your order has been dispatched.',
  "Sorry for the trouble - we'll make this right.",
  'Refund initiated, should reflect in 3-5 days.',
  'Replacement is on its way.',
];

// Plain-English labels so the founder never sees internal codes like
// "founder_replied" or "wrong_item".
const STATUS_LABELS = {
  open: 'New — needs a reply',
  founder_replied: 'You replied',
  resolved: 'Resolved',
};
const ISSUE_LABELS = {
  delay: 'Late delivery',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  missing: 'Missing item',
  refund_request: 'Refund request',
  other: 'Other',
};
const ISSUE_TYPES = ['delay', 'damaged', 'wrong_item', 'missing', 'refund_request', 'other'];

let apiKey = localStorage.getItem(API_KEY_STORAGE) || '';
let currentTab = 'tickets'; // 'tickets' | 'chats'
let ticketFilter = 'open'; // 'open' | 'resolved'
let currentThread = null; // { kind: 'ticket'|'chat', id, data }
let listCache = [];
let slaHours = 6;

// ---------- DOM refs ----------
const el = (id) => document.getElementById(id);
const loginScreen = el('login-screen');
const loginError = el('login-error');
const mainScreen = el('main-screen');
const listView = el('list-view');
const listScreen = el('list-screen');
const ticketFilterEl = el('ticket-filter');
const threadScreen = el('thread-screen');
const threadMessages = el('thread-messages');
const threadActions = el('thread-actions');
const quickRepliesEl = el('quick-replies');
const topbarTitle = el('topbar-title');
const topbarSubtitle = el('topbar-subtitle');
const backButton = el('back-button');
const profileButton = el('profile-button');
const profileScreen = el('profile-screen');
const profileBody = el('profile-body');
const ticketsCountEl = el('tickets-count');
const testBanner = el('test-banner');
const testScreen = el('test-screen');
const testBody = el('test-body');
const navTest = el('nav-test');

// ---------- API helper ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem(API_KEY_STORAGE);
    showLogin();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
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

// ---------- Login ----------
function showLogin() {
  loginScreen.classList.remove('hidden');
  mainScreen.classList.add('hidden');
}
function showMain() {
  loginScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
}

el('login-button').addEventListener('click', doLogin);
el('login-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const value = el('login-input').value.trim();
  if (!value) return;
  apiKey = value;
  loginError.classList.add('hidden');
  try {
    await api('/api/tickets'); // sanity check the key works
    localStorage.setItem(API_KEY_STORAGE, apiKey);
    showMain();
    loadConfig();
    loadList();
  } catch (err) {
    loginError.classList.remove('hidden');
  }
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg && cfg.slaHours) slaHours = cfg.slaHours;
    const testMode = !!(cfg && cfg.testMode);
    testBanner.classList.toggle('hidden', !testMode);
    navTest.classList.toggle('hidden', !testMode);
  } catch (err) {
    /* keep default */
  }
}

// ---------- Tabs & navigation ----------
el('nav-tickets').addEventListener('click', () => switchTab('tickets'));
el('nav-chats').addEventListener('click', () => switchTab('chats'));
navTest.addEventListener('click', () => switchTab('test'));
backButton.addEventListener('click', () => {
  // From a profile, "back" returns to the conversation it was opened from.
  if (!profileScreen.classList.contains('hidden') && currentThread) {
    openThread(currentThread.kind, currentThread.id);
  } else {
    closeThread();
  }
});
profileButton.addEventListener('click', () => {
  if (currentThread) showProfile(currentThread.data.customerPhone);
});
el('refresh-button').addEventListener('click', () => {
  if (!profileScreen.classList.contains('hidden') && currentThread) showProfile(currentThread.data.customerPhone);
  else if (currentThread) openThread(currentThread.kind, currentThread.id);
  else if (currentTab === 'test') renderTestScreen(true);
  else loadList();
});

for (const btn of ticketFilterEl.querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    ticketFilter = btn.dataset.filter;
    for (const b of ticketFilterEl.querySelectorAll('button')) {
      b.classList.toggle('active', b === btn);
    }
    loadList();
  });
}

function switchTab(tab) {
  currentTab = tab;
  el('nav-tickets').classList.toggle('active', tab === 'tickets');
  el('nav-chats').classList.toggle('active', tab === 'chats');
  navTest.classList.toggle('active', tab === 'test');
  closeThread();
  if (tab === 'test') {
    listView.classList.add('hidden');
    testScreen.classList.remove('hidden');
    renderTestScreen();
    return Promise.resolve();
  }
  testScreen.classList.add('hidden');
  return loadList();
}

// ---------- List screen ----------
async function loadList() {
  const isTickets = currentTab === 'tickets';
  topbarTitle.textContent = isTickets ? 'Tickets' : 'Chats';
  topbarSubtitle.classList.add('hidden');
  ticketFilterEl.classList.toggle('hidden', !isTickets);
  listScreen.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    if (isTickets) {
      const path = ticketFilter === 'resolved' ? '/api/tickets?status=resolved' : '/api/tickets';
      listCache = await api(path);
      renderTicketList(listCache);
    } else {
      listCache = await api('/api/conversations');
      renderChatList(listCache);
    }
  } catch (err) {
    listScreen.innerHTML =
      '<div class="empty-state">Couldn\'t load. Check your connection and tap ↻ to try again.</div>';
  }
}

function displayName(item) {
  return (item.customerName && item.customerName.trim()) || item.customerPhone || 'Unknown';
}

function isOverdue(ticket) {
  if (ticket.status === 'resolved') return false;
  const age = Date.now() - new Date(ticket.lastActivityAt).getTime();
  return age > slaHours * 60 * 60 * 1000;
}

function updateTicketBadge(openCount) {
  ticketsCountEl.textContent = openCount;
  ticketsCountEl.classList.toggle('hidden', openCount === 0);
}

function renderTicketList(tickets) {
  // The nav badge always reflects tickets that still need attention.
  if (ticketFilter === 'open') updateTicketBadge(tickets.length);

  if (tickets.length === 0) {
    listScreen.innerHTML =
      ticketFilter === 'resolved'
        ? '<div class="empty-state">No resolved tickets yet.</div>'
        : '<div class="empty-state"><span class="big">✅</span>All caught up! No tickets need attention.</div>';
    return;
  }

  listScreen.innerHTML = '';
  for (const t of tickets) {
    const overdue = isOverdue(t);
    const item = document.createElement('div');
    item.className = 'list-item' + (overdue ? ' attention' : '');
    item.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(displayName(t))}</span>
        <span class="time">${relativeTime(t.lastActivityAt)}</span>
      </div>
      <div class="row2">
        <span class="badge badge-${t.issueType}">${escapeHtml(ISSUE_LABELS[t.issueType] || t.issueType)}</span>
        ${overdue ? '<span class="attention-pill">Needs attention</span>' : `<span class="status-pill">${escapeHtml(statusLabel(t.status))}</span>`}
      </div>
      <div class="row2"><span class="ticket-no">Ticket #${t.ticketNumber}</span></div>
    `;
    item.addEventListener('click', () => openThread('ticket', t._id));
    listScreen.appendChild(item);
  }
}

function renderChatList(conversations) {
  if (conversations.length === 0) {
    listScreen.innerHTML = '<div class="empty-state">No general chats right now.</div>';
    return;
  }
  listScreen.innerHTML = '';
  for (const c of conversations) {
    const item = document.createElement('div');
    item.className = 'list-item' + (c.unread ? ' attention' : '');
    item.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(displayName(c))}</span>
        <span class="time">${relativeTime(c.lastMessageAt)}</span>
      </div>
      <div class="preview">${escapeHtml(c.lastMessagePreview || '')}</div>
    `;
    item.addEventListener('click', () => openThread('chat', c._id));
    listScreen.appendChild(item);
  }
}

// ---------- Thread screen ----------
async function openThread(kind, id) {
  listView.classList.add('hidden');
  profileScreen.classList.add('hidden');
  threadScreen.classList.remove('hidden');
  backButton.classList.remove('hidden');
  profileButton.classList.remove('hidden');
  threadMessages.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    let messages, data;
    if (kind === 'ticket') {
      const res = await api(`/api/tickets/${id}`);
      data = res.ticket;
      messages = res.messages;
    } else {
      messages = await api(`/api/conversations/${id}/messages`);
      data = listCache.find((c) => c._id === id) || {};
    }
    currentThread = { kind, id, data };

    topbarTitle.textContent = displayName(data);
    if (kind === 'ticket') {
      topbarSubtitle.textContent = `Ticket #${data.ticketNumber} · ${ISSUE_LABELS[data.issueType] || data.issueType}`;
    } else {
      topbarSubtitle.textContent = data.customerName ? data.customerPhone : 'General chat';
    }
    topbarSubtitle.classList.remove('hidden');

    renderMessages(messages);
    renderQuickReplies();
    renderThreadActions();
  } catch (err) {
    threadMessages.innerHTML = '<div class="empty-state">Couldn\'t load this conversation.</div>';
  }
}

function closeThread() {
  currentThread = null;
  threadScreen.classList.add('hidden');
  profileScreen.classList.add('hidden');
  listView.classList.remove('hidden');
  backButton.classList.add('hidden');
  profileButton.classList.add('hidden');
  topbarSubtitle.classList.add('hidden');
  topbarTitle.textContent = currentTab === 'tickets' ? 'Tickets' : 'Chats';
}

// ---------- Customer profile (CRM) ----------
async function showProfile(phone) {
  threadScreen.classList.add('hidden');
  listView.classList.add('hidden');
  profileScreen.classList.remove('hidden');
  backButton.classList.remove('hidden');
  profileButton.classList.add('hidden');
  topbarTitle.textContent = 'Customer';
  topbarSubtitle.classList.add('hidden');
  profileBody.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const p = await api(`/api/customers/${phone}`);
    renderProfile(p);
  } catch (err) {
    profileBody.innerHTML = '<div class="empty-state">Couldn\'t load this customer.</div>';
  }
}

function money(amount, currency) {
  const n = Number(amount) || 0;
  if (currency === 'INR' || !currency) return '₹' + n.toLocaleString('en-IN');
  return `${n.toLocaleString()} ${currency}`;
}

function renderProfile(p) {
  const s = p.shopify || { found: false };
  const name = p.name || p.phone;
  const orderRows = (s.orders || [])
    .map(
      (o) => `
      <div class="profile-row">
        <div><div>${escapeHtml(o.name)}</div><div class="sub">${new Date(o.createdAt).toLocaleDateString()} · ${escapeHtml(fulfilLabel(o.fulfillmentStatus))}</div></div>
        <span class="amount">${money(o.total, s.currency)}</span>
      </div>`
    )
    .join('');

  const ticketRows = (p.tickets || [])
    .map(
      (t) => `
      <div class="profile-row">
        <div><div>${escapeHtml(ISSUE_LABELS[t.issueType] || t.issueType)}</div><div class="sub">Ticket #${t.ticketNumber} · ${escapeHtml(statusLabel(t.status))}</div></div>
        <span class="sub">${relativeTime(t.lastActivityAt)}</span>
      </div>`
    )
    .join('');

  profileBody.innerHTML = `
    <div class="profile-head">
      <span class="profile-status status-${p.status}">${escapeHtml(p.statusLabel || p.status)}</span>
      <div class="profile-name">${escapeHtml(name)}</div>
      <div class="profile-phone">${escapeHtml(p.phone)}</div>
    </div>

    <div class="stat-row">
      <div class="stat"><div class="value">${s.found ? s.ordersCount : '—'}</div><div class="label">Orders</div></div>
      <div class="stat"><div class="value">${s.found ? money(s.totalSpent, s.currency) : '—'}</div><div class="label">Total spent</div></div>
      <div class="stat"><div class="value">${s.lastOrderAt ? relativeTime(s.lastOrderAt) : '—'}</div><div class="label">Last order</div></div>
    </div>

    <div class="profile-section">
      <h3>Order history</h3>
      <div class="profile-card">
        ${s.error ? '<div class="profile-empty">Couldn\'t reach Shopify right now.</div>' : orderRows || '<div class="profile-empty">No orders found for this number.</div>'}
      </div>
    </div>

    <div class="profile-section">
      <h3>Past tickets</h3>
      <div class="profile-card">
        ${ticketRows || '<div class="profile-empty">No support tickets yet.</div>'}
      </div>
    </div>

    <div class="profile-section">
      <h3>Private note</h3>
      <textarea id="notes-area" class="notes-area" placeholder="e.g. Allergic to nuts · prefers Sunday delivery · buys in bulk for her studio">${escapeHtml(p.notes || '')}</textarea>
      <div style="display:flex; gap:12px; align-items:center;">
        <button id="notes-save" class="notes-save">Save note</button>
        <span id="notes-saved" class="notes-saved hidden">Saved ✓</span>
      </div>
    </div>

    <div class="profile-section">
      <h3>Marketing</h3>
      <label class="optin-row">
        <div>
          <div class="optin-label">Opted in to marketing</div>
          <div class="optin-sub">Include this customer in broadcasts</div>
        </div>
        <span class="switch"><input type="checkbox" id="optin-toggle" ${p.optedInMarketing ? 'checked' : ''}><span class="track"></span></span>
      </label>
    </div>
  `;

  el('notes-save').addEventListener('click', async () => {
    try {
      await api(`/api/customers/${p.phone}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: el('notes-area').value }),
      });
      const saved = el('notes-saved');
      saved.classList.remove('hidden');
      setTimeout(() => saved.classList.add('hidden'), 2000);
    } catch (err) {
      alert('Could not save the note. Please try again.');
    }
  });

  el('optin-toggle').addEventListener('change', async (e) => {
    try {
      await api(`/api/customers/${p.phone}`, {
        method: 'PATCH',
        body: JSON.stringify({ optedInMarketing: e.target.checked }),
      });
    } catch (err) {
      e.target.checked = !e.target.checked;
      alert('Could not update. Please try again.');
    }
  });
}

function fulfilLabel(status) {
  const map = {
    UNFULFILLED: 'Not shipped',
    PARTIALLY_FULFILLED: 'Partly shipped',
    FULFILLED: 'Shipped',
    RESTOCKED: 'Returned',
    IN_PROGRESS: 'Packing',
    ON_HOLD: 'On hold',
    SCHEDULED: 'Scheduled',
  };
  return map[status] || 'Processing';
}

function renderMessages(messages) {
  threadMessages.innerHTML = '';
  if (!messages || messages.length === 0) {
    threadMessages.innerHTML = '<div class="empty-state">No messages yet.</div>';
    return;
  }
  for (const m of messages) {
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${m.direction}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.body;
    wrap.appendChild(bubble);
    if (m.createdAt) {
      const time = document.createElement('div');
      time.className = 'bubble-time';
      time.textContent = clockTime(m.createdAt);
      wrap.appendChild(time);
    }
    threadMessages.appendChild(wrap);
  }
  threadMessages.scrollTop = threadMessages.scrollHeight;
}

function renderQuickReplies() {
  quickRepliesEl.innerHTML = '';
  for (const text of QUICK_REPLIES) {
    const btn = document.createElement('button');
    btn.textContent = text.length > 28 ? text.slice(0, 26) + '…' : text;
    btn.title = text;
    btn.addEventListener('click', () => {
      el('composer-input').value = text;
      el('composer-input').focus();
    });
    quickRepliesEl.appendChild(btn);
  }
}

function renderThreadActions() {
  threadActions.innerHTML = '';
  threadActions.classList.remove('hidden');

  if (currentThread.kind === 'ticket') {
    if (currentThread.data.status === 'resolved') {
      const note = document.createElement('div');
      note.className = 'actions-label';
      note.textContent = 'This ticket is resolved. Replying will reopen the conversation.';
      threadActions.appendChild(note);
      return;
    }
    const resolveBtn = document.createElement('button');
    resolveBtn.className = 'primary';
    resolveBtn.textContent = '✓ Mark resolved';
    resolveBtn.addEventListener('click', async () => {
      if (!confirm(`Mark ticket #${currentThread.data.ticketNumber} as resolved?`)) return;
      try {
        await api(`/api/tickets/${currentThread.id}/resolve`, { method: 'POST' });
        closeThread();
        loadList();
      } catch (err) {
        alert('Could not update the ticket. Please try again.');
      }
    });
    threadActions.appendChild(resolveBtn);
  } else {
    const flagBtn = document.createElement('button');
    flagBtn.textContent = '⚑ Flag as an issue';
    flagBtn.addEventListener('click', showIssuePicker);
    threadActions.appendChild(flagBtn);
  }
}

// Tappable issue-type picker (replaces the old typed prompt).
function showIssuePicker() {
  threadActions.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'actions-label';
  label.textContent = 'What kind of issue is this?';
  threadActions.appendChild(label);

  for (const type of ISSUE_TYPES) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = ISSUE_LABELS[type];
    chip.addEventListener('click', async () => {
      try {
        await api(`/api/conversations/${currentThread.id}/flag-ticket`, {
          method: 'POST',
          body: JSON.stringify({ issueType: type }),
        });
        closeThread();
        ticketFilter = 'open';
        for (const b of ticketFilterEl.querySelectorAll('button')) {
          b.classList.toggle('active', b.dataset.filter === 'open');
        }
        switchTab('tickets');
      } catch (err) {
        alert('Could not flag this chat. Please try again.');
      }
    });
    threadActions.appendChild(chip);
  }

  const cancel = document.createElement('button');
  cancel.className = 'chip chip-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', renderThreadActions);
  threadActions.appendChild(cancel);
}

el('composer-send').addEventListener('click', sendReply);
el('composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendReply();
  }
});

async function sendReply() {
  const input = el('composer-input');
  const body = input.value.trim();
  if (!body || !currentThread) return;
  input.value = '';

  const path =
    currentThread.kind === 'ticket'
      ? `/api/tickets/${currentThread.id}/reply`
      : `/api/conversations/${currentThread.id}/reply`;

  try {
    await api(path, { method: 'POST', body: JSON.stringify({ body }) });
    openThread(currentThread.kind, currentThread.id); // reload thread to show the sent message
  } catch (err) {
    alert('Could not send — check your connection and try again.');
    input.value = body;
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
  ['General question', 'Do you have Jain options without onion and garlic?'],
];
let testCustomers = null;

async function renderTestScreen(reload = false) {
  topbarTitle.textContent = 'Test';
  topbarSubtitle.classList.add('hidden');
  testBody.innerHTML = `
    <p class="test-intro">Pretend a customer just messaged you on WhatsApp and see exactly what your inbox does. Nothing is sent to anyone.</p>
    <div class="test-field">
      <label for="test-customer">Customer</label>
      <select id="test-customer"><option>Loading your Shopify customers…</option></select>
    </div>
    <div id="test-custom" class="test-field hidden">
      <input id="test-phone" inputmode="numeric" placeholder="Phone with country code, e.g. 919876543210">
      <input id="test-name" placeholder="Their name (optional)">
    </div>
    <div class="test-field">
      <label for="test-text">Their message</label>
      <div id="test-chips" class="test-chips"></div>
      <textarea id="test-text" rows="3" placeholder="Type what the customer says, or tap an example above"></textarea>
    </div>
    <div class="test-actions">
      <button id="test-send" class="test-send">Send as customer</button>
      <button id="test-photo" class="test-photo">Send a photo</button>
    </div>
    <div id="test-result"></div>`;

  for (const [label, text] of TEST_SAMPLES) {
    const chip = document.createElement('button');
    chip.textContent = label;
    chip.addEventListener('click', () => {
      el('test-text').value = text;
    });
    el('test-chips').appendChild(chip);
  }
  el('test-send').addEventListener('click', () => sendTestMessage('text'));
  el('test-photo').addEventListener('click', () => sendTestMessage('image'));

  if (!testCustomers || reload) {
    try {
      testCustomers = await api('/api/test/customers');
    } catch (err) {
      testCustomers = [];
    }
  }
  const select = el('test-customer');
  if (!select) return; // user left the Test tab while loading
  select.innerHTML =
    testCustomers
      .map((c, i) => {
        const orders = `${c.ordersCount} order${c.ordersCount === 1 ? '' : 's'}`;
        return `<option value="${i}">${escapeHtml(c.name || 'Customer')} · …${c.phone.slice(-4)} · ${orders}</option>`;
      })
      .join('') + '<option value="custom">Someone else (type a number)</option>';
  const syncCustom = () => el('test-custom').classList.toggle('hidden', select.value !== 'custom');
  select.addEventListener('change', syncCustom);
  syncCustom();
}

async function sendTestMessage(type) {
  const choice = el('test-customer').value;
  const customer = choice === 'custom' ? null : testCustomers[Number(choice)];
  const body = {
    type,
    phone: customer ? customer.phone : el('test-phone').value,
    name: customer ? customer.name : el('test-name').value,
    text: el('test-text').value,
  };
  const resultEl = el('test-result');
  el('test-send').disabled = true;
  el('test-photo').disabled = true;
  resultEl.innerHTML = '<div class="test-result">Sending…</div>';

  try {
    const r = await api('/api/test/simulate', { method: 'POST', body: JSON.stringify(body) });
    renderTestResult(r);
    if (type === 'text') el('test-text').value = '';
    const open = await api('/api/tickets');
    updateTicketBadge(open.length);
  } catch (err) {
    resultEl.innerHTML = `<div class="test-result error">${escapeHtml(err.message)}</div>`;
  } finally {
    if (el('test-send')) el('test-send').disabled = false;
    if (el('test-photo')) el('test-photo').disabled = false;
  }
}

function renderTestResult(r) {
  const issue = ISSUE_LABELS[r.issueType] || r.issueType;
  const outcome = {
    auto_answered: 'Answered automatically from Shopify. No work for you.',
    ticket_created: `Ticket #${r.ticketNumber} created (${issue}). It's waiting in your Tickets tab.`,
    added_to_ticket: `Added to their open Ticket #${r.ticketNumber}.`,
    chat: 'Added to your Chats for you to reply.',
  }[r.outcome];
  const replies = r.replies.length
    ? '<div class="would-receive">The customer would receive</div>' +
      r.replies.map((t) => `<div class="reply">${escapeHtml(t)}</div>`).join('')
    : '<div class="would-receive">No automatic reply</div>';
  const isTicket = !!r.ticketId;

  el('test-result').innerHTML = `
    <div class="test-result ok">
      <div class="outcome">${escapeHtml(outcome)}</div>
      ${replies}
      <button id="test-open" class="open-btn">${isTicket ? 'Open the ticket' : 'Open the chat'}</button>
    </div>`;
  el('test-open').addEventListener('click', async () => {
    if (isTicket) {
      ticketFilter = 'open';
      for (const b of ticketFilterEl.querySelectorAll('button')) {
        b.classList.toggle('active', b.dataset.filter === 'open');
      }
      await switchTab('tickets');
      openThread('ticket', r.ticketId);
    } else {
      await switchTab('chats');
      openThread('chat', r.conversationId);
    }
  });
}

// ---------- Utilities ----------
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function relativeTime(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clockTime(dateStr) {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (err) {
    return '';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------- Boot ----------
if (apiKey) {
  showMain();
  loadConfig();
  loadList();
} else {
  showLogin();
}

// Poll for updates every 25s while looking at a list (cheap, avoids needing websockets).
setInterval(() => {
  const loggedIn = loginScreen.classList.contains('hidden');
  if (apiKey && loggedIn && !currentThread && currentTab !== 'test') {
    loadList();
  }
}, 25000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}
