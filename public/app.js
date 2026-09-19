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

let apiKey = localStorage.getItem(API_KEY_STORAGE) || '';
let currentTab = 'tickets'; // 'tickets' | 'chats'
let currentThread = null; // { kind: 'ticket'|'chat', id, data }
let listCache = [];

// ---------- DOM refs ----------
const el = (id) => document.getElementById(id);
const loginScreen = el('login-screen');
const mainScreen = el('main-screen');
const listScreen = el('list-screen');
const threadScreen = el('thread-screen');
const threadMessages = el('thread-messages');
const threadActions = el('thread-actions');
const quickRepliesEl = el('quick-replies');
const topbarTitle = el('topbar-title');
const ticketsCountEl = el('tickets-count');

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
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
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
  mainScreen.style.display = 'flex';
}

el('login-button').addEventListener('click', async () => {
  const value = el('login-input').value.trim();
  if (!value) return;
  apiKey = value;
  try {
    await api('/api/tickets'); // sanity check the key works
    localStorage.setItem(API_KEY_STORAGE, apiKey);
    showMain();
    loadList();
  } catch (err) {
    alert('That access code was rejected - check it and try again.');
  }
});

// ---------- Tabs ----------
el('nav-tickets').addEventListener('click', () => switchTab('tickets'));
el('nav-chats').addEventListener('click', () => switchTab('chats'));
el('refresh-button').addEventListener('click', () => {
  if (threadScreen.classList.contains('hidden')) loadList();
  else openThread(currentThread.kind, currentThread.id);
});

function switchTab(tab) {
  currentTab = tab;
  el('nav-tickets').classList.toggle('active', tab === 'tickets');
  el('nav-chats').classList.toggle('active', tab === 'chats');
  closeThread();
  loadList();
}

// ---------- List screen ----------
async function loadList() {
  topbarTitle.textContent = currentTab === 'tickets' ? 'Tickets' : 'Chats';
  listScreen.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    if (currentTab === 'tickets') {
      listCache = await api('/api/tickets');
      renderTicketList(listCache);
    } else {
      listCache = await api('/api/conversations');
      renderChatList(listCache);
    }
  } catch (err) {
    listScreen.innerHTML = '<div class="empty-state">Could not load. Pull to refresh or check your connection.</div>';
  }
}

function renderTicketList(tickets) {
  const openCount = tickets.filter((t) => t.status !== 'resolved').length;
  ticketsCountEl.textContent = openCount;
  ticketsCountEl.classList.toggle('hidden', openCount === 0);

  if (tickets.length === 0) {
    listScreen.innerHTML = '<div class="empty-state">No open tickets. 🎉</div>';
    return;
  }
  listScreen.innerHTML = '';
  for (const t of tickets) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="row1">
        <span class="title">#${t.ticketNumber} · ${t.customerPhone}</span>
        <span class="time">${relativeTime(t.lastActivityAt)}</span>
      </div>
      <div>
        <span class="badge badge-${t.issueType}">${t.issueType.replace('_', ' ')}</span>
        <span class="preview" style="margin-left:6px;">${t.status.replace('_', ' ')}</span>
      </div>
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
    item.className = 'list-item';
    item.innerHTML = `
      <div class="row1">
        <span class="title">${c.customerPhone}</span>
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
  listScreen.classList.add('hidden');
  threadScreen.classList.remove('hidden');
  threadScreen.style.display = 'flex';
  threadMessages.innerHTML = '<div class="empty-state">Loading...</div>';
  topbarTitle.textContent = kind === 'ticket' ? 'Ticket' : 'Chat';

  try {
    let messages, data;
    if (kind === 'ticket') {
      const res = await api(`/api/tickets/${id}`);
      data = res.ticket;
      messages = res.messages;
    } else {
      messages = await api(`/api/conversations/${id}/messages`);
      data = listCache.find((c) => c._id === id);
    }
    currentThread = { kind, id, data };
    renderMessages(messages);
    renderQuickReplies();
    renderThreadActions();
  } catch (err) {
    threadMessages.innerHTML = '<div class="empty-state">Could not load this thread.</div>';
  }
}

function closeThread() {
  currentThread = null;
  threadScreen.classList.add('hidden');
  listScreen.classList.remove('hidden');
}

function renderMessages(messages) {
  threadMessages.innerHTML = '';
  for (const m of messages) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${m.direction}`;
    bubble.textContent = m.body;
    threadMessages.appendChild(bubble);
  }
  threadMessages.scrollTop = threadMessages.scrollHeight;
}

function renderQuickReplies() {
  quickRepliesEl.innerHTML = '';
  for (const text of QUICK_REPLIES) {
    const btn = document.createElement('button');
    btn.textContent = text.length > 28 ? text.slice(0, 26) + '...' : text;
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
  if (currentThread.kind === 'ticket') {
    threadActions.classList.remove('hidden');
    const resolveBtn = document.createElement('button');
    resolveBtn.className = 'primary';
    resolveBtn.textContent = 'Mark resolved';
    resolveBtn.addEventListener('click', async () => {
      await api(`/api/tickets/${currentThread.id}/resolve`, { method: 'POST' });
      closeThread();
      loadList();
    });
    threadActions.appendChild(resolveBtn);
  } else {
    threadActions.classList.remove('hidden');
    const flagBtn = document.createElement('button');
    flagBtn.textContent = 'Flag as issue / ticket';
    flagBtn.addEventListener('click', async () => {
      const type = prompt('Issue type: delay, damaged, wrong_item, missing, refund_request, other', 'other');
      if (!type) return;
      await api(`/api/conversations/${currentThread.id}/flag-ticket`, {
        method: 'POST',
        body: JSON.stringify({ issueType: type }),
      });
      closeThread();
      switchTab('tickets');
    });
    threadActions.appendChild(flagBtn);
  }
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
    alert('Could not send - check your connection and try again.');
    input.value = body;
  }
}

// ---------- Utilities ----------
function relativeTime(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Boot ----------
if (apiKey) {
  showMain();
  loadList();
} else {
  showLogin();
}

// Poll for updates every 25s while looking at a list (cheap, avoids needing websockets).
setInterval(() => {
  const loggedIn = loginScreen.classList.contains('hidden');
  const onListScreen = threadScreen.classList.contains('hidden');
  if (apiKey && loggedIn && onListScreen) {
    loadList();
  }
}, 25000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}
