// Shared pieces for every screen: app state, the API helper, formatting and
// icons. No build step: plain ES modules the browser loads directly.

export const API_KEY_STORAGE = 'thakar_inbox_api_key';

export const state = {
  apiKey: safeGet(API_KEY_STORAGE) || '',
  config: { slaHours: 6, testMode: false, founderName: '', ai: null },
  route: { view: 'home', id: null, pane: 'list', sub: null },
};

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

export function saveKey(key) {
  state.apiKey = key;
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch (err) {
    /* private window: stays for this visit only */
  }
}

export const el = (id) => document.getElementById(id);

// Set by main.js: what to do when the access code is rejected.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.apiKey}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    onUnauthorized();
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

export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
export const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body || {}) });
export const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body || {}) });
export const del = (path) => api(path, { method: 'DELETE' });

// ---------- Text & numbers ----------
export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatPhone(phone) {
  const p = String(phone || '');
  if (/^91\d{10}$/.test(p)) return `+91 ${p.slice(2, 7)} ${p.slice(7)}`;
  return p ? `+${p}` : '';
}

export function displayName(item) {
  return (item.customerName && item.customerName.trim()) || (item.name && item.name.trim()) || formatPhone(item.customerPhone || item.phone) || 'Customer';
}

export function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '#';
  if (/^\d/.test(words[0])) return words[words.length - 1].slice(-2);
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

const AVATAR_COLOURS = ['#F2B829', '#E9B99A', '#D9C6A5', '#C9D8B6', '#E3C9E1', '#BFD3E6', '#F2D39B'];
export function avatarColour(key) {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

export function avatar(item) {
  const phone = item.customerPhone || item.phone;
  return `<span class="avatar" style="background:${avatarColour(phone)}" aria-hidden="true">${escapeHtml(initials(displayName(item)))}</span>`;
}

export function ago(dateStr) {
  if (!dateStr) return '';
  const mins = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function listTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  if (now - d < 6 * 24 * 60 * 60 * 1000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function dayLabel(d) {
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

export function clock(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(d)}`;
}

export function shortDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function money(amount, currency) {
  const n = Number(amount) || 0;
  if (!currency || currency === 'INR') {
    const r = Math.round(n * 100) / 100;
    return '₹' + r.toLocaleString('en-IN', { maximumFractionDigits: r % 1 ? 2 : 0 });
  }
  return `${n.toLocaleString()} ${currency}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${Number(n).toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

let toastTimer = null;
export function toast(message) {
  const t = el('toast');
  t.textContent = message;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---------- Labels ----------
export const ISSUE_LABELS = {
  delay: 'Late delivery',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  missing: 'Missing item',
  refund_request: 'Refund request',
  quality: 'Quality complaint',
  payment: 'Payment issue',
  other: 'Other issue',
};
export const ISSUE_TYPES = ['delay', 'damaged', 'wrong_item', 'missing', 'quality', 'payment', 'refund_request', 'other'];

// What the app sent by itself, shown above the message.
export const AUTO_LABELS = {
  order_status: 'Auto-reply · Order status',
  ai_answer: 'Auto-reply · AI answer',
  ticket: 'Auto-reply · Ticket opened',
  order_confirmed: 'Automatic · Order confirmed',
  cod_request: 'Automatic · COD confirmation',
  cod_reply: 'Automatic · COD answer noted',
  order_shipped: 'Automatic · Order shipped',
  out_for_delivery: 'Automatic · Out for delivery',
  order_delivered: 'Automatic · Delivered',
  cart_reminder: 'Automatic · Cart reminder',
  reorder_reminder: 'Automatic · Reorder reminder',
  back_in_stock: 'Automatic · Back in stock',
  campaign: 'Campaign',
  campaign_test: 'Campaign test',
  opt_out: 'Automatic · Stopped offers',
  opt_in: 'Automatic · Opted in to offers',
};

export const SEGMENT_LABELS = {
  all: 'Everyone',
  vip: 'VIP',
  returning: 'Returning',
  one_order: 'Ordered once',
  lapsed: 'Lapsed 45+ days',
  no_orders: 'No orders yet',
  opted_in: 'Opted in to offers',
};

// ---------- Icons ----------
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-4-.9L3 20l1.1-4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  forward: '<path d="m9 18 6-6-6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  truck: '<path d="M1 4h14v12H1z"/><path d="M15 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  cart: '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L22 7H6"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17v4M17 19h4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function ico(name, cls = '') {
  return `<span class="ico ${cls}">${icon(name)}</span>`;
}

export function fillIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (!node.firstChild) node.innerHTML = icon(node.dataset.icon);
  }
}

const TICK_ONE = '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 3 3 6-7"/></svg>';
const TICK_TWO = '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1 6 3 3 6-7"/><path d="m7 9 6-7"/></svg>';

export function tickHtml(status, test) {
  if (test) return '<span class="not-sent" title="Test mode: this was not actually sent">not sent</span>';
  if (status === 'read') return `<span class="tick read" title="Read">${TICK_TWO}</span>`;
  if (status === 'delivered') return `<span class="tick" title="Delivered">${TICK_TWO}</span>`;
  if (status === 'sent') return `<span class="tick" title="Sent">${TICK_ONE}</span>`;
  if (status === 'queued') return `<span class="tick" title="Sending">${icon('clock')}</span>`;
  return '';
}

export function setInboxCount(n) {
  for (const node of document.querySelectorAll('[data-count="inbox"]')) {
    node.textContent = n > 99 ? '99+' : String(n);
    node.classList.toggle('hidden', !n);
  }
}

// A switch (checkbox styled as a toggle) with an accessible label.
export function switchHtml(id, checked, label, disabled = false) {
  return `<span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${escapeHtml(label)}" /><span class="track"></span></span>`;
}

// Renders `html` into a view only if the user is still on it.
export function isCurrent(view) {
  return state.route.view === view;
}
