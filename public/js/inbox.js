// The inbox: every customer's chat, one chat at a time, and the customer
// panel. On a computer the three sit side by side; on a phone it's one
// screen at a time.
import {
  state, api, post, el, escapeHtml, formatPhone, displayName, avatar, ago, listTime, dayLabel, clock, toast, money,
  icon, ISSUE_LABELS, ISSUE_TYPES, AUTO_LABELS, tickHtml, setInboxCount,
} from './core.js';
import { renderProfile, loadProfile } from './profile.js';

const QUICK_REPLIES = [
  "Thanks, we're on it!",
  'Your order has been dispatched.',
  "Sorry for the trouble, we'll make this right.",
  'Refund initiated, it should reflect in 3-5 days.',
  'A replacement is on its way.',
];

const inbox = { filter: 'all', q: '', items: [], counts: null, loaded: false };
let thread = null; // { id, conversation, messages }
let profile = null;
const mediaUrls = new Map(); // message id -> object URL

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
  const kind = c.last && c.last.autoAck;
  if (kind === 'ai_answer') return { text: 'AI answered', cls: 'pill-green' };
  if (kind === 'order_status') return { text: 'Order status sent', cls: 'pill-green' };
  if (kind === 'cod_reply') return { text: 'COD answered', cls: 'pill-green' };
  if (kind === 'opt_out') return { text: 'Stopped offers', cls: '' };
  return null;
}

// ---------- List ----------
export function setFilter(filter, reload = true) {
  inbox.filter = filter;
  for (const b of el('filter-chips').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  }
  if (reload) loadInbox();
  else inbox.loaded = false;
}

let inboxRequest = 0;
export async function loadInbox() {
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
      // Ticks only when the preview is our own reply (automatic updates don't
      // change the preview).
      const ownPreview = c.last && c.last.direction === 'outbound' && (c.last.sentByFounder || ['ai_answer', 'order_status'].includes(c.last.autoAck));
      return `
        <a class="chat-item${c.needsReply ? ' needs' : ''}" href="#/inbox/${c._id}" aria-current="${state.route.id === c._id}">
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
export async function openThread(id) {
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
    resetCart();
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
  const sig = (list) => list.map((m) => `${m._id}:${m.status || ''}:${(m.cart && m.cart.order && m.cart.order.name) || ''}`).join('|');
  const messagesChanged = changed || sig(thread.messages) !== sig(data.messages);
  thread.conversation = data.conversation;
  thread.messages = data.messages;
  renderThreadHead();
  if (changed || !el('thread-strip').querySelector('.issue-picker')) renderStrip();
  // Composer first: it can change the height of the message area, which must
  // be final before scrolling to the newest message.
  renderComposer();
  if (messagesChanged) renderMessages(changed);
  if (changed) refreshProfile();
}

export function closeThread() {
  thread = null;
  profile = null;
  threadRequest++;
  resetCart();
  el('thread').classList.add('hidden');
  el('thread-empty').classList.remove('hidden');
  el('customer-body').innerHTML = '<div class="empty">Pick a chat to see who it is.</div>';
}

async function refreshProfile() {
  if (!thread || !thread.conversation) return;
  const forId = thread.id;
  try {
    const p = await loadProfile(thread.conversation.customerPhone);
    if (!thread || thread.id !== forId) return;
    profile = p;
    renderThreadHead();
    renderProfile(el('customer-body'), p, { onTagsChanged: loadInbox });
  } catch (err) {
    if (thread && thread.id === forId) {
      el('customer-body').innerHTML = `<div class="empty"><b>Couldn't load this customer</b>${escapeHtml(err.message)}</div>`;
    }
  }
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
    await post(`/api/tickets/${t._id}/resolve`);
    toast(`Ticket #${t.ticketNumber} resolved`);
    await openThread(thread.id);
    loadInbox();
    refreshProfile();
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
        const t = await post(`/api/conversations/${thread.id}/flag-ticket`, { issueType: b.dataset.issue });
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

// Web links in a message become tappable (http and https only), long ones
// shortened for display. Works on already-escaped text, so it stops at
// escaped quotes and brackets.
function linkify(escaped) {
  return escaped.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s<>"'])+/g, (url) => {
    const tail = (url.match(/[.,;:!?)\]]+$/) || [''])[0];
    const href = tail ? url.slice(0, -tail.length) : url;
    const bare = href.replace(/^https?:\/\//, '');
    const text = bare.length > 48 ? `${bare.slice(0, 45).replace(/&[a-z0-9#]*$/i, '')}…` : bare;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${href}">${text}</a>${tail}`;
  });
}

// Under a cart link: whether the customer has ordered since.
function cartStatusHtml(c) {
  if (!c.order) return '<div class="cart-status"><span class="pill">Not ordered yet</span></div>';
  const how = c.order.exact ? 'Placed from this cart link' : 'Placed within 3 days of this cart link';
  return `<div class="cart-status"><span class="pill pill-green" title="${how}">${icon('check')}Ordered · ${escapeHtml(c.order.name)}</span></div>`;
}

function messageHtml(m) {
  const out = m.direction === 'outbound';
  const label = out && m.autoAck ? AUTO_LABELS[m.autoAck] || 'Auto-reply' : out && m.cart ? 'Cart link' : '';
  const hasMedia = !!m.media;
  const caption = hasMedia ? (/^\[(photo|audio|video|document|sticker)\]$/.test(m.body) ? '' : m.body) : m.body;
  const failed = m.status === 'failed'
    ? `<div class="meta failed">Not delivered${m.statusError ? `: ${escapeHtml(m.statusError)}` : ''}</div>`
    : '';
  const buttons = (m.buttons || []).length
    ? `<div class="bubble-buttons">${m.buttons.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>`
    : '';
  const tapped = !out && m.type === 'button' ? '<span class="auto-label">Tapped a button</span>' : '';
  return `
    <div class="bubble ${out ? 'out' : 'in'}${hasMedia ? ' media' : ''}${m.type === 'template' ? ' template' : ''}">
      ${label ? `<span class="auto-label">${escapeHtml(label)}</span>` : tapped}
      ${hasMedia ? mediaHtml(m) : ''}
      ${caption ? `<div class="caption">${linkify(escapeHtml(caption))}</div>` : ''}
      ${out && m.cart ? cartStatusHtml(m.cart) : ''}
      <div class="meta">${escapeHtml(clock(m.createdAt))}${out ? tickHtml(m.status === 'failed' ? null : m.status, m.test) : ''}</div>
      ${failed}
      ${buttons}
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
  const res = await fetch(`/api/media/${id}`, { headers: { Authorization: `Bearer ${state.apiKey}` } });
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
    mediaUrl(video.dataset.video)
      .then((url) => (video.src = url))
      .catch(() => video.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Video no longer available' })));
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

// ---------- Composer ----------
function renderComposer() {
  const w = windowState(thread.conversation);
  el('composer').classList.toggle('hidden', !w.open);
  syncCartVisibility();
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

let sending = false;
async function sendReply() {
  const input = el('composer-input');
  const body = input.value.trim();
  if (!body || !thread || sending) return;
  sending = true;
  el('composer-send').disabled = true;
  try {
    const message = await post(`/api/conversations/${thread.id}/reply`, { body });
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

// ---------- Cart builder ----------
// The founder picks products and quantities; the customer gets a message
// with the list and one link that opens the shop's cart with those items,
// ready for address and payment (Magic Checkout). Kept as a draft until
// it's sent or another chat is opened.
const CART_MAX_LINES = 20;
const CART_MAX_QTY = 50;
let cart = { open: false, lines: [], sending: false };

function resetCart() {
  cart = { open: false, lines: [], sending: false };
  el('cart-builder').innerHTML = '';
  syncCartVisibility();
}

function lineName(l) {
  return l.variantTitle ? `${l.productTitle} (${l.variantTitle})` : l.productTitle;
}

// The builder shows only while the reply window is open; quick replies make
// way for it.
function syncCartVisibility() {
  const open = !!(thread && thread.conversation && windowState(thread.conversation).open);
  const show = cart.open && open;
  el('cart-builder').classList.toggle('hidden', !show);
  el('quick-replies').classList.toggle('hidden', !open || show);
  const btn = el('cart-btn');
  btn.setAttribute('aria-expanded', String(show));
  btn.classList.toggle('active', show);
}

// Keeps the newest message in view when the builder opens or closes.
function keepMessagesInView(change) {
  const box = el('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  change();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function openCart() {
  if (!thread || !thread.conversation) return;
  const c = thread.conversation;
  const first = (c.customerName || '').trim().split(/\s+/)[0];
  const box = el('cart-builder');
  box.innerHTML = `
    <div class="cart-head">
      <span class="ico">${icon('cart')}</span>
      <b class="grow">Cart for ${escapeHtml(first || displayName(c))}</b>
      <button type="button" class="icon-btn" data-cart-close aria-label="Close the cart"><span class="ico">${icon('close')}</span></button>
    </div>
    <label class="search small"><span class="ico">${icon('search')}</span><input type="search" placeholder="Find a product, e.g. methi papad" aria-label="Find a product" autocomplete="off" data-cart-q /></label>
    <div class="cart-scroll">
      <div class="product-results" data-cart-results></div>
      <div class="cart-lines" data-cart-lines></div>
    </div>
    <div class="cart-foot">
      <span class="cart-total" data-cart-total></span>
      <button type="button" class="btn btn-primary" data-cart-send>Send cart link</button>
    </div>`;
  box.querySelector('[data-cart-close]').addEventListener('click', () => closeCart());
  box.querySelector('[data-cart-send]').addEventListener('click', sendCart);
  box.addEventListener('keydown', onCartKey);
  wireCartSearch(box);
  cart.open = true;
  keepMessagesInView(syncCartVisibility);
  renderCartLines();
  box.querySelector('[data-cart-q]').focus();
}

function closeCart() {
  cart.open = false;
  const box = el('cart-builder');
  box.removeEventListener('keydown', onCartKey);
  keepMessagesInView(() => {
    box.innerHTML = '';
    syncCartVisibility();
  });
}

function onCartKey(e) {
  if (e.key !== 'Escape') return;
  closeCart();
  el('cart-btn').focus();
}

function wireCartSearch(box) {
  const input = box.querySelector('[data-cart-q]');
  const results = box.querySelector('[data-cart-results]');
  let timer = null;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    seq++;
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      results.innerHTML = '<div class="muted">Searching…</div>';
      try {
        const products = await api(`/api/products?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        renderCartResults(input, results, products);
      } catch (err) {
        if (mine === seq) results.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
      }
    }, 300);
  });
}

function renderCartResults(input, results, products) {
  if (!products.length) {
    results.innerHTML = '<div class="muted">No products found. Try another word.</div>';
    return;
  }
  results.innerHTML = products
    .map((p, pi) => {
      const chips = p.variants
        .map((v, vi) => {
          const why = p.onStore === false ? 'not on the website' : !v.available ? 'sold out' : '';
          return `<button type="button" class="chip-btn${why ? ' sold-out' : ''}" data-p="${pi}" data-v="${vi}"${why ? ' disabled' : ''}>${escapeHtml(v.title || 'Add')} · ${escapeHtml(money(v.price))}${why ? ` · ${why}` : ''}</button>`;
        })
        .join('');
      return `<div class="product-row"><b>${escapeHtml(p.title)}</b><div class="product-options">${chips}</div></div>`;
    })
    .join('');
  for (const b of results.querySelectorAll('[data-p]')) {
    b.addEventListener('click', () => {
      const p = products[b.dataset.p];
      if (!addCartLine(p, p.variants[b.dataset.v])) return;
      input.value = '';
      results.innerHTML = '';
      // Ready for the next product on a computer; on a phone the keyboard
      // would hide the cart.
      if (window.matchMedia('(min-width: 900px)').matches) input.focus();
      else input.blur();
    });
  }
}

function addCartLine(p, v) {
  const line = cart.lines.find((l) => l.variantId === v.id);
  if (line) {
    line.quantity = Math.min(CART_MAX_QTY, line.quantity + 1);
  } else {
    if (cart.lines.length >= CART_MAX_LINES) {
      toast(`At most ${CART_MAX_LINES} different products in one cart`);
      return false;
    }
    cart.lines.push({ variantId: v.id, productTitle: p.title, variantTitle: v.title, price: v.price, quantity: 1 });
  }
  renderCartLines();
  return true;
}

function renderCartLines() {
  const box = el('cart-builder');
  const list = box.querySelector('[data-cart-lines]');
  if (!list) return;
  list.innerHTML = cart.lines.length
    ? cart.lines
        .map((l, i) => {
          const name = escapeHtml(lineName(l));
          return `
          <div class="cart-line">
            <span class="cart-line-name">${escapeHtml(l.productTitle)}<small>${l.variantTitle ? `${escapeHtml(l.variantTitle)} · ` : ''}${escapeHtml(money(l.price))} each</small></span>
            <span class="qty">
              <button type="button" class="qty-btn" data-dec="${i}" aria-label="${l.quantity > 1 ? `One less ${name}` : `Remove ${name}`}">${icon('minus')}</button>
              <span class="qty-n" aria-label="Quantity">${l.quantity}</span>
              <button type="button" class="qty-btn" data-inc="${i}" aria-label="One more ${name}"${l.quantity >= CART_MAX_QTY ? ' disabled' : ''}>${icon('plus')}</button>
            </span>
            <span class="cart-line-total">${escapeHtml(money(l.price * l.quantity))}</span>
            <button type="button" class="icon-btn line-remove" data-remove="${i}" aria-label="Remove ${name}"><span class="ico">${icon('close')}</span></button>
          </div>`;
        })
        .join('')
    : '<div class="cart-empty">Search for a product and tap a size to add it. Add as many products as you like.</div>';
  const change = (i, by) => {
    const l = cart.lines[i];
    l.quantity = Math.min(CART_MAX_QTY, l.quantity + by);
    if (l.quantity < 1) cart.lines.splice(i, 1);
    renderCartLines();
  };
  for (const b of list.querySelectorAll('[data-dec]')) b.addEventListener('click', () => change(Number(b.dataset.dec), -1));
  for (const b of list.querySelectorAll('[data-inc]')) b.addEventListener('click', () => change(Number(b.dataset.inc), 1));
  for (const b of list.querySelectorAll('[data-remove]')) {
    b.addEventListener('click', () => {
      cart.lines.splice(Number(b.dataset.remove), 1);
      renderCartLines();
    });
  }
  const total = cart.lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const items = cart.lines.reduce((sum, l) => sum + l.quantity, 0);
  box.querySelector('[data-cart-total]').innerHTML = cart.lines.length
    ? `${items} ${items === 1 ? 'item' : 'items'} · <b>${escapeHtml(money(total))}</b>`
    : '';
  const send = box.querySelector('[data-cart-send]');
  send.disabled = !cart.lines.length || cart.sending;
  send.textContent = cart.sending ? 'Sending…' : 'Send cart link';
}

async function sendCart() {
  if (!thread || cart.sending || !cart.lines.length) return;
  const forId = thread.id;
  cart.sending = true;
  renderCartLines();
  try {
    const message = await post(`/api/conversations/${forId}/cart-link`, {
      items: cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    });
    if (!thread || thread.id !== forId) return;
    resetCart();
    thread.messages.push(message);
    renderMessages(true);
    openThread(thread.id);
    loadInbox();
  } catch (err) {
    toast(`Not sent: ${err.message}`);
  } finally {
    cart.sending = false;
    renderCartLines();
  }
}

// ---------- Wiring (once) ----------
export function initInbox() {
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
  el('thread-who').addEventListener('click', () => {
    if (thread) location.hash = customerPath();
  });
  el('profile-btn').addEventListener('click', () => {
    if (thread) location.hash = customerPath();
  });
  el('customer-close').addEventListener('click', () => {
    location.hash = thread ? `#/inbox/${thread.id}` : '#/inbox';
  });
  el('lightbox-close').addEventListener('click', closeLightbox);
  el('lightbox').addEventListener('click', (e) => {
    if (e.target === el('lightbox')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('lightbox').classList.contains('hidden')) closeLightbox();
  });
  el('composer-input').addEventListener('input', autosize);
  el('composer-input').addEventListener('keydown', (e) => {
    // Enter sends on a computer; on phones Enter adds a new line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) {
      e.preventDefault();
      sendReply();
    }
  });
  el('composer-send').addEventListener('click', sendReply);
  el('cart-btn').addEventListener('click', () => (cart.open ? closeCart() : openCart()));
}

// Called by the router when the inbox is shown.
export function showInbox(route, prev) {
  if (!inbox.loaded || prev.view !== 'inbox') loadInbox();
  else renderChatList();
  if (route.id && (!thread || thread.id !== route.id)) openThread(route.id);
  if (!route.id) closeThread();
}

// Called every few seconds while the inbox is open.
export function refreshInbox() {
  loadInbox();
  const active = document.activeElement;
  const editing = active && (active.matches('[data-note]') || active.classList.contains('tag-input') || active.matches('[data-product-q], [data-cart-q]'));
  if (thread && !editing) openThread(thread.id);
}

export function reopenThread() {
  if (thread) openThread(thread.id);
}
