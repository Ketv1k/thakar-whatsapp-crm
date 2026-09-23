// Customers: everyone from Shopify plus everyone who messaged, in groups
// (VIP, lapsed, opted in...), with a profile panel and "send a campaign".
import { state, api, post, el, escapeHtml, formatPhone, avatar, ago, money, toast, ico, isCurrent, plural, SEGMENT_LABELS } from './core.js';
import { renderProfile, loadProfile } from './profile.js';

const list = { segment: 'all', tag: '', q: '', page: 0, items: [], data: null };
let detailPhone = null;

function statusPill(status) {
  if (status === 'vip') return '<span class="pill pill-vip">VIP</span>';
  if (status === 'returning') return '<span class="pill pill-green">Returning</span>';
  return '<span class="pill">New</span>';
}

function syncNote(d) {
  if (!d.shopifyConnected) return 'Shopify is not connected, so only people who messaged you are listed.';
  if (d.sync.importing) return 'Importing your Shopify customers… this takes a few minutes the first time.';
  if (!d.sync.lastRunAt) return 'Your Shopify customers will be imported in a moment.';
  return `Updated from Shopify ${ago(d.sync.lastRunAt)} ago.`;
}

async function loadList(append = false) {
  const params = new URLSearchParams({ segment: list.segment, page: String(list.page) });
  if (list.tag) params.set('tag', list.tag);
  if (list.q) params.set('q', list.q);
  const d = await api(`/api/customers?${params}`);
  list.data = d;
  list.items = append ? [...list.items, ...d.items] : d.items;
  return d;
}

function renderShell() {
  const view = el('view-customers');
  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Customers</h1>
          <p class="page-sub" data-sub>Loading…</p>
        </div>
        <label class="search wide">${ico('search')}<input type="search" placeholder="Name, number, city or tag" aria-label="Search customers" data-q value="${escapeHtml(list.q)}" /></label>
      </header>
      <div class="chips wrap" role="group" aria-label="Groups" data-segments></div>
      <div class="split" data-split>
        <div class="split-main">
          <div class="table-card" data-table></div>
          <div class="action-bar" data-bar></div>
        </div>
        <aside class="split-side customer-side" data-side aria-label="Customer"></aside>
      </div>
    </div>`;
  let timer = null;
  view.querySelector('[data-q]').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      list.q = e.target.value.trim();
      list.page = 0;
      refresh();
    }, 300);
  });
}

function renderSegments() {
  const d = list.data;
  const box = el('view-customers').querySelector('[data-segments]');
  const tagOptions = ['<option value="">Any tag</option>', ...d.tags.map((t) => `<option value="${escapeHtml(t)}" ${t === list.tag ? 'selected' : ''}>${escapeHtml(t)}</option>`)].join('');
  box.innerHTML =
    d.segments
      .map((s) => `<button type="button" aria-pressed="${s.key === list.segment}" data-seg="${s.key}">${escapeHtml(s.label)} <span>${(d.counts[s.key] || 0).toLocaleString('en-IN')}</span></button>`)
      .join('') + (d.tags.length ? `<select class="tag-filter" aria-label="Filter by tag" data-tag>${tagOptions}</select>` : '');
  for (const b of box.querySelectorAll('[data-seg]')) {
    b.addEventListener('click', () => {
      list.segment = b.dataset.seg;
      list.page = 0;
      refresh();
    });
  }
  const tagSel = box.querySelector('[data-tag]');
  if (tagSel) {
    tagSel.addEventListener('change', () => {
      list.tag = tagSel.value;
      list.page = 0;
      refresh();
    });
  }
}

function renderTable() {
  const d = list.data;
  const table = el('view-customers').querySelector('[data-table]');
  if (!list.items.length) {
    table.innerHTML = `<div class="empty"><b>No customers here</b>${list.q ? 'Try a different search.' : escapeHtml(syncNote(d))}</div>`;
    return;
  }
  table.innerHTML = `
    <div class="ctable" role="table" aria-label="Customers">
      <div class="crow chead" role="row">
        <span role="columnheader">Customer</span><span role="columnheader">Status</span><span role="columnheader" class="num">Orders</span>
        <span role="columnheader" class="num">Spent</span><span role="columnheader">Last order</span><span role="columnheader">Tags</span><span role="columnheader">Offers</span>
      </div>
      ${list.items
        .map(
          (c) => `
        <a class="crow" role="row" href="#/customers/${c.phone}" aria-current="${detailPhone === c.phone}">
          <span class="ccell-who" role="cell">${avatar(c)}<span><b>${escapeHtml(c.name || formatPhone(c.phone))}</b><small>${escapeHtml(formatPhone(c.phone))}${c.city ? ` · ${escapeHtml(c.city)}` : ''}</small></span></span>
          <span role="cell">${statusPill(c.status)}</span>
          <span role="cell" class="num">${c.ordersCount || 0}</span>
          <span role="cell" class="num">${money(c.totalSpent || 0, c.currency)}</span>
          <span role="cell">${c.lastOrderAt ? `${escapeHtml(ago(c.lastOrderAt))} ago` : '—'}</span>
          <span role="cell" class="ctags">${escapeHtml((c.tags || []).join(', ')) || '—'}</span>
          <span role="cell" class="${c.optedInMarketing ? 'yes' : 'no'}">${c.optedInMarketing ? 'Opted in' : 'Not opted in'}</span>
        </a>`
        )
        .join('')}
    </div>
    ${list.items.length < d.total ? `<button type="button" class="btn more-btn" data-more>Show more (${(d.total - list.items.length).toLocaleString('en-IN')} left)</button>` : ''}`;
  const more = table.querySelector('[data-more]');
  if (more) {
    more.addEventListener('click', async () => {
      more.disabled = true;
      list.page++;
      await loadList(true);
      renderTable();
    });
  }
}

function renderBar() {
  const d = list.data;
  const bar = el('view-customers').querySelector('[data-bar]');
  const label = `${SEGMENT_LABELS[list.segment] || 'Group'}${list.tag ? ` · ${list.tag}` : ''}`;
  const notOptedIn = d.total - d.optedIn;
  bar.innerHTML = `
    <div class="bar-text">
      <b>${escapeHtml(label)} · ${plural(d.total, 'customer')}</b>
      <span>${d.optedIn.toLocaleString('en-IN')} opted in to offers, so they can get a campaign.</span>
    </div>
    ${notOptedIn > 0 && list.segment !== 'opted_in' ? '<button type="button" class="btn btn-ghost" data-bulk>Opt them in…</button>' : ''}
    <a class="btn btn-saffron" href="#/campaigns/new?segment=${encodeURIComponent(list.segment)}&tag=${encodeURIComponent(list.tag)}">Send a campaign to them</a>`;
  const bulk = bar.querySelector('[data-bulk]');
  if (bulk) {
    bulk.addEventListener('click', async () => {
      const ok = confirm(
        `Opt in ${notOptedIn.toLocaleString('en-IN')} customers to offers on WhatsApp?\n\nOnly do this if they already agreed to get offers from you on WhatsApp (for example in Zoko or at checkout). Anyone who replied STOP stays out, and anyone can reply STOP later.`
      );
      if (!ok) return;
      try {
        const r = await post('/api/customers/bulk-opt-in', { segment: list.segment, tag: list.tag, confirm: true });
        toast(`${plural(r.changed, 'customer')} opted in`);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

async function refresh() {
  try {
    await loadList(false);
  } catch (err) {
    el('view-customers').querySelector('[data-table]').innerHTML = `<div class="empty"><b>Couldn't load customers</b>${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!isCurrent('customers')) return;
  const d = list.data;
  el('view-customers').querySelector('[data-sub]').textContent =
    `${plural(d.counts.all || 0, 'customer')} · ${(d.counts.opted_in || 0).toLocaleString('en-IN')} opted in to offers. ${syncNote(d)}`;
  renderSegments();
  renderTable();
  renderBar();
}

async function showDetail(phone) {
  const side = el('view-customers').querySelector('[data-side]');
  const split = el('view-customers').querySelector('[data-split]');
  detailPhone = phone;
  split.classList.toggle('has-side', !!phone);
  for (const row of el('view-customers').querySelectorAll('.crow[href]')) {
    row.setAttribute('aria-current', String(row.getAttribute('href') === `#/customers/${phone}`));
  }
  if (!phone) {
    side.innerHTML = '';
    return;
  }
  side.innerHTML = `
    <header class="customer-head side-head"><a class="icon-btn" href="#/customers" aria-label="Back to customers">${ico('back')}</a><span>Customer</span></header>
    <div class="customer-body" data-body><div class="empty">Loading…</div></div>`;
  try {
    const p = await loadProfile(phone);
    if (detailPhone !== phone) return;
    renderProfile(side.querySelector('[data-body]'), p, { showChatLink: true, onTagsChanged: refresh });
  } catch (err) {
    side.querySelector('[data-body]').innerHTML = `<div class="empty"><b>Couldn't load</b>${escapeHtml(err.message)}</div>`;
  }
}

export async function showCustomers(route, prev) {
  if (prev.view !== 'customers' || !el('view-customers').querySelector('[data-table]')) {
    renderShell();
    await refresh();
  }
  const phone = /^\d{6,15}$/.test(route.id || '') ? route.id : null;
  if (phone !== detailPhone || prev.view !== 'customers') await showDetail(phone);
}

export function refreshCustomers() {
  if (!detailPhone) refresh();
}
