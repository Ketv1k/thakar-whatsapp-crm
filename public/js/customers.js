// Customers: everyone from Shopify plus everyone who messaged, sorted into
// stages (New, Needs 2nd order, Loyal...), narrowed with simple filters,
// saved as groups, downloaded, imported, and sent a campaign. Plus the tools
// to grow the list of people who get offers.
import {
  state, api, post, put, del, el, escapeHtml, formatPhone, avatar, ago, money, toast, ico, isCurrent, plural,
  SEGMENT_LABELS, STAGE_PILLS, isOwner,
} from './core.js';
import { renderProfile, loadProfile } from './profile.js';

const list = { segment: 'all', group: null, filters: {}, q: '', page: 0, items: [], data: null, filtersOpen: false, growOpen: false };
let detailPhone = null;
let products = null; // for the Bought filters, loaded once

const ORDER_CHOICES = [['', 'Any'], ['1', '1 order'], ['2+', '2 or more'], ['3+', '3 or more'], ['5+', '5 or more']];
const SPENT_CHOICES = [['', 'Any'], ['1000', '₹1,000+'], ['2500', '₹2,500+'], ['5000', '₹5,000+'], ['10000', '₹10,000+']];
const LAST_CHOICES = [['', 'Any time'], ['30', 'In the last 30 days'], ['30-90', '30 to 90 days ago'], ['90+', 'More than 90 days ago'], ['never', 'Never ordered']];
const PAYS_CHOICES = [['', 'Any'], ['online', 'Mostly online'], ['cod', 'Mostly COD']];
const OFFERS_CHOICES = [['', 'Any'], ['yes', 'Yes'], ['no', 'No']];

function stagePill(stage) {
  if (!stage || stage === 'all') return '<span class="muted">—</span>';
  return `<span class="pill ${STAGE_PILLS[stage] || ''}">${escapeHtml(SEGMENT_LABELS[stage] || stage)}</span>`;
}

function hasFilters() {
  return Object.keys(list.filters).length > 0;
}

// Human words for the current filters (the server sends the same text).
function describe() {
  return (list.data && list.data.describe) || '';
}

function groupLabel() {
  if (list.group) {
    const g = (list.data.groups || []).find((x) => x._id === list.group);
    if (g) return g.name;
  }
  const stage = SEGMENT_LABELS[list.segment] || 'Everyone';
  return hasFilters() ? `${list.segment === 'all' ? '' : `${stage} · `}${describe()}` : stage;
}

function queryParams(extra = {}) {
  const params = new URLSearchParams({ segment: list.segment, ...extra });
  if (hasFilters()) params.set('filters', JSON.stringify(list.filters));
  if (list.q) params.set('q', list.q);
  return params;
}

function syncNote(d) {
  if (!d.shopifyConnected) return 'Shopify is not connected, so only people who messaged you are listed.';
  if (d.sync.importing) return 'Importing your Shopify customers… this takes a few minutes the first time.';
  if (!d.sync.lastRunAt) return 'Your Shopify customers will be imported in a moment.';
  if (!d.sync.historyDone) return `Updated from Shopify ${ago(d.sync.lastRunAt)} ago. Still reading past orders, so "Bought" filters fill in over the next hour.`;
  return `Updated from Shopify ${ago(d.sync.lastRunAt)} ago.`;
}

async function loadList(append = false) {
  const d = await api(`/api/customers?${queryParams({ page: String(list.page) })}`);
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
        <div class="head-actions">
          ${isOwner() ? `<button type="button" class="btn" data-grow-toggle aria-expanded="false">${ico('megaphone')}Grow your offers list</button>` : ''}
          <label class="search wide">${ico('search')}<input type="search" placeholder="Name, number, city or tag" aria-label="Search customers" data-q value="${escapeHtml(list.q)}" /></label>
        </div>
      </header>
      <section class="card grow-card hidden" data-grow aria-label="Grow your offers list"></section>
      <div class="chips wrap" role="group" aria-label="Groups" data-segments></div>
      <div class="filter-row" data-filter-row></div>
      <section class="card filter-card hidden" data-filter-card aria-label="Filters"></section>
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
  const growToggle = view.querySelector('[data-grow-toggle]');
  if (growToggle) {
    growToggle.addEventListener('click', () => {
      list.growOpen = !list.growOpen;
      renderGrow();
    });
  }
}

// ---------- Stages and saved groups ----------
function renderSegments() {
  const d = list.data;
  const box = el('view-customers').querySelector('[data-segments]');
  const stages = d.segments
    .map((s) => {
      const on = !list.group && s.key === list.segment;
      return `<button type="button" aria-pressed="${on}" data-seg="${s.key}" title="${escapeHtml(s.help || '')}">${escapeHtml(s.label)} <span>${(d.counts[s.key] || 0).toLocaleString('en-IN')}</span></button>`;
    })
    .join('');
  const groups = (d.groups || [])
    .map((g) => `<button type="button" class="saved" aria-pressed="${list.group === g._id}" data-group="${g._id}" title="${escapeHtml(g.describe)}">★ ${escapeHtml(g.name)} <span>${(g.count || 0).toLocaleString('en-IN')}</span></button>`)
    .join('');
  box.innerHTML = stages + groups;
  for (const b of box.querySelectorAll('[data-seg]')) {
    b.addEventListener('click', () => {
      list.segment = b.dataset.seg;
      list.group = null;
      list.page = 0;
      refresh();
    });
  }
  for (const b of box.querySelectorAll('[data-group]')) {
    b.addEventListener('click', () => {
      const g = d.groups.find((x) => x._id === b.dataset.group);
      list.group = g._id;
      list.segment = g.segment;
      list.filters = { ...g.filters };
      list.page = 0;
      refresh();
    });
  }
}

const FILTER_WORDS = {
  bought: (v) => `Bought: ${v}`,
  notBought: (v) => `Never bought: ${v}`,
  orders: (v) => `Orders: ${v === '1' ? '1' : v}`,
  minSpent: (v) => `Spent ₹${Number(v).toLocaleString('en-IN')}+`,
  lastOrder: (v) => `Last order: ${(LAST_CHOICES.find((c) => c[0] === v) || [])[1] || v}`,
  pays: (v) => (v === 'cod' ? 'Mostly COD' : 'Mostly online'),
  place: (v) => `In: ${v}`,
  tag: (v) => `Tag: ${v}`,
  offers: (v) => (v === 'yes' ? 'Gets offers' : "Doesn't get offers"),
  birthday: () => 'Birthday this month',
};

function renderFilterRow() {
  const view = el('view-customers');
  const row = view.querySelector('[data-filter-row]');
  const g = list.group ? (list.data.groups || []).find((x) => x._id === list.group) : null;
  const stageHelp = (list.data.segments.find((s) => s.key === list.segment) || {}).help || '';
  const help = g ? `Your group: ${g.describe || 'everyone'}.` : stageHelp;
  const chips = Object.entries(list.filters)
    .map(([k, v]) => `<span class="fchip">${escapeHtml(FILTER_WORDS[k] ? FILTER_WORDS[k](v) : `${k}: ${v}`)}<button type="button" data-unset="${k}" aria-label="Remove this filter">${ico('close')}</button></span>`)
    .join('');
  const canSave = !g && (list.segment !== 'all' || hasFilters());
  row.innerHTML = `
    <p class="stage-help">${escapeHtml(help)}</p>
    <div class="fchips">
      ${chips}
      <button type="button" class="btn btn-small" data-filters-toggle aria-expanded="${list.filtersOpen}">${ico('plus')}${hasFilters() ? 'More filters' : 'Filter'}</button>
      ${hasFilters() ? '<button type="button" class="link-btn" data-clear>Clear filters</button>' : ''}
      ${canSave ? '<button type="button" class="link-btn" data-save-group>Save as a group</button>' : ''}
      ${g ? '<button type="button" class="link-btn" data-delete-group>Delete this group</button>' : ''}
    </div>`;
  for (const b of row.querySelectorAll('[data-unset]')) {
    b.addEventListener('click', () => {
      delete list.filters[b.dataset.unset];
      list.group = null;
      list.page = 0;
      refresh();
    });
  }
  row.querySelector('[data-filters-toggle]').addEventListener('click', () => {
    list.filtersOpen = !list.filtersOpen;
    renderFilterCard();
    row.querySelector('[data-filters-toggle]').setAttribute('aria-expanded', String(list.filtersOpen));
  });
  const clear = row.querySelector('[data-clear]');
  if (clear) {
    clear.addEventListener('click', () => {
      list.filters = {};
      list.group = null;
      list.page = 0;
      refresh();
    });
  }
  const save = row.querySelector('[data-save-group]');
  if (save) {
    save.addEventListener('click', async () => {
      const name = prompt('Name this group, e.g. "Kaju Curry fans" or "COD in Gujarat"');
      if (!name || !name.trim()) return;
      try {
        const g = await post('/api/customers/groups', { name: name.trim(), segment: list.segment, filters: list.filters });
        list.group = g._id;
        toast(`Saved "${g.name}". It's in the list of groups, and you can send campaigns to it.`);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  const remove = row.querySelector('[data-delete-group]');
  if (remove) {
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete the group "${g.name}"? The customers stay; only the saved group goes.`)) return;
      try {
        await del(`/api/customers/groups/${g._id}`);
        list.group = null;
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

function selectHtml(key, label, choices, value) {
  return `<label class="ffield"><span>${escapeHtml(label)}</span><select data-f="${key}">${choices
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(value || '') === v ? 'selected' : ''}>${escapeHtml(l)}</option>`)
    .join('')}</select></label>`;
}

async function renderFilterCard() {
  const card = el('view-customers').querySelector('[data-filter-card]');
  card.classList.toggle('hidden', !list.filtersOpen);
  if (!list.filtersOpen) return;
  // (Asked again while it's empty: past orders may still be importing.)
  if (!products || !products.length) {
    card.innerHTML = '<div class="muted">Loading…</div>';
    try {
      products = await api('/api/customers/products');
    } catch (err) {
      products = [];
    }
  }
  const f = list.filters;
  const productChoices = [['', products.length ? 'Any product' : 'No order history yet'], ...products.map((p) => [p.title, `${p.title} (${p.customers.toLocaleString('en-IN')})`])];
  const tagChoices = [['', 'Any tag'], ...(list.data.tags || []).map((t) => [t, t])];
  card.innerHTML = `
    <div class="filter-grid">
      ${selectHtml('bought', 'Bought', productChoices, f.bought)}
      ${selectHtml('notBought', 'Never bought', productChoices.map((c, i) => (i === 0 ? ['', 'Any product'] : c)), f.notBought)}
      ${selectHtml('orders', 'Number of orders', ORDER_CHOICES, f.orders)}
      ${selectHtml('minSpent', 'Total spent', SPENT_CHOICES, f.minSpent)}
      ${selectHtml('lastOrder', 'Last order', LAST_CHOICES, f.lastOrder)}
      ${selectHtml('pays', 'Pays by', PAYS_CHOICES, f.pays)}
      <label class="ffield"><span>City, state or pincode</span><input data-f="place" value="${escapeHtml(f.place || '')}" placeholder="e.g. Ahmedabad" maxlength="40" /></label>
      ${selectHtml('tag', 'Tag', tagChoices, f.tag)}
      ${selectHtml('offers', 'Gets offers', OFFERS_CHOICES, f.offers)}
      <label class="ffield check"><input type="checkbox" data-f="birthday" ${f.birthday ? 'checked' : ''} /><span>Birthday this month</span></label>
    </div>
    <div class="filter-foot"><button type="button" class="btn btn-small btn-dark" data-done>Done</button></div>`;
  const apply = (key, value) => {
    if (value) list.filters[key] = value;
    else delete list.filters[key];
    list.group = null;
    list.page = 0;
    refresh();
  };
  for (const input of card.querySelectorAll('[data-f]')) {
    const key = input.dataset.f;
    if (input.type === 'checkbox') input.addEventListener('change', () => apply(key, input.checked ? 'month' : ''));
    else if (input.tagName === 'SELECT') input.addEventListener('change', () => apply(key, input.value));
    else {
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => apply(key, input.value.trim()), 400);
      });
    }
  }
  card.querySelector('[data-done]').addEventListener('click', () => {
    list.filtersOpen = false;
    renderFilterCard();
    renderFilterRow();
  });
}

// ---------- The list ----------
function renderTable() {
  const d = list.data;
  const table = el('view-customers').querySelector('[data-table]');
  if (!list.items.length) {
    table.innerHTML = `<div class="empty"><b>No customers here</b>${list.q || hasFilters() ? 'Try a different search or fewer filters.' : escapeHtml(syncNote(d))}</div>`;
    return;
  }
  table.innerHTML = `
    <div class="ctable" role="table" aria-label="Customers">
      <div class="crow chead" role="row">
        <span role="columnheader">Customer</span><span role="columnheader">Stage</span><span role="columnheader" class="num">Orders</span>
        <span role="columnheader" class="num">Spent</span><span role="columnheader">Last order</span><span role="columnheader">Tags</span><span role="columnheader">Offers</span>
      </div>
      ${list.items
        .map(
          (c) => `
        <a class="crow" role="row" href="#/customers/${c.phone}" aria-current="${detailPhone === c.phone}">
          <span class="ccell-who" role="cell">${avatar(c)}<span><b>${escapeHtml(c.name || formatPhone(c.phone))}</b><small>${escapeHtml(formatPhone(c.phone))}${c.city ? ` · ${escapeHtml(c.city)}` : ''}</small></span></span>
          <span role="cell">${stagePill(c.stage)}</span>
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

function campaignHref() {
  const params = new URLSearchParams({ segment: list.segment, label: list.group || hasFilters() ? groupLabel() : '' });
  if (hasFilters()) params.set('filters', JSON.stringify(list.filters));
  return `#/campaigns/new?${params}`;
}

async function download() {
  try {
    const res = await fetch(`/api/customers/export?${queryParams()}`, { headers: { Authorization: `Bearer ${state.apiKey}` } });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `customers-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    toast(`Couldn't download: ${err.message}`);
  }
}

function renderBar() {
  const d = list.data;
  const bar = el('view-customers').querySelector('[data-bar]');
  const notOptedIn = d.total - d.optedIn;
  bar.innerHTML = `
    <div class="bar-text">
      <b>${escapeHtml(groupLabel())} · ${plural(d.total, 'customer')}</b>
      <span>${d.optedIn.toLocaleString('en-IN')} of them get offers, so they can get a campaign.</span>
    </div>
    ${isOwner() ? `<button type="button" class="btn btn-ghost" data-download>${ico('download')}Download list</button>` : ''}
    ${isOwner() && notOptedIn > 0 && list.filters.offers !== 'yes' ? '<button type="button" class="btn btn-ghost" data-bulk>Opt them in…</button>' : ''}
    ${isOwner() ? `<a class="btn btn-saffron" href="${escapeHtml(campaignHref())}">Send a campaign to them</a>` : ''}`;
  const dl = bar.querySelector('[data-download]');
  if (dl) dl.addEventListener('click', download);
  const bulk = bar.querySelector('[data-bulk]');
  if (bulk) {
    bulk.addEventListener('click', async () => {
      const reason = prompt(
        `Opt in ${notOptedIn.toLocaleString('en-IN')} customers to offers on WhatsApp?\n\nOnly if every one of them already agreed to get offers from Thakar Kitchen on WhatsApp. Anyone who replied STOP stays out.\n\nWhere did they agree? This is saved on each customer as proof (e.g. "Opted in on Zoko, Aug 2026").`
      );
      if (!reason || reason.trim().length < 3) return;
      try {
        const r = await post('/api/customers/bulk-opt-in', { segment: list.segment, filters: list.filters, confirm: true, reason: reason.trim() });
        toast(`${plural(r.changed, 'customer')} opted in`);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

// ---------- Grow the offers list ----------
async function renderGrow() {
  const view = el('view-customers');
  const card = view.querySelector('[data-grow]');
  const toggle = view.querySelector('[data-grow-toggle]');
  if (toggle) toggle.setAttribute('aria-expanded', String(list.growOpen));
  card.classList.toggle('hidden', !list.growOpen);
  if (!list.growOpen) return;
  card.innerHTML = '<div class="muted">Loading…</div>';
  let g;
  try {
    g = await api('/api/customers/grow');
  } catch (err) {
    card.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
    return;
  }
  card.innerHTML = `
    <div class="grow-head">
      <div>
        <h2>Grow your offers list</h2>
        <p class="card-note">Campaigns and reminders only go to people who agreed to get offers on WhatsApp. <b>${plural(g.optedIn, 'person', 'people')}</b> have so far. Three ways to add more:</p>
      </div>
      <button type="button" class="icon-btn" data-grow-close aria-label="Close">${ico('close')}</button>
    </div>
    <div class="grow-grid">
      <div class="grow-item">
        <h3><span>1</span> Import a list</h3>
        <p>Have a list from Zoko or a spreadsheet? Save it as a CSV file and add it here. The phone number column is found automatically.</p>
        <label class="file-pick"><input type="file" accept=".csv,text/csv" data-file /><span class="btn btn-small">Choose CSV file</span><span class="muted" data-file-name>No file chosen</span></label>
        <label class="check-line"><input type="checkbox" data-import-optin /> They agreed to get offers from Thakar Kitchen on WhatsApp</label>
        <input class="plain-input hidden" data-import-reason placeholder="Where did they agree? e.g. Opted in on Zoko" maxlength="200" />
        <input class="plain-input" data-import-tag placeholder="Tag them, e.g. Zoko (optional)" maxlength="30" />
        <div data-import-result></div>
      </div>
      <div class="grow-item">
        <h3><span>2</span> People who agreed at checkout</h3>
        <div class="grow-row">
          <p><b>${plural(g.shopifyWhatsApp, 'customer')}</b> agreed to WhatsApp marketing in Shopify. They're added automatically. (Shopify's SMS consent isn't used: it isn't permission for WhatsApp.)</p>
        </div>
        <div class="grow-row">
          <p><b>${plural(g.checkoutConsent, 'person', 'people')}</b> ticked the WhatsApp box at checkout but didn't finish their order.</p>
          ${g.checkoutConsent ? '<button type="button" class="btn btn-small" data-checkout>Add them</button>' : ''}
        </div>
      </div>
      <div class="grow-item">
        <h3><span>3</span> Share a link or QR code</h3>
        ${g.link.url
          ? `<p>Put it on your website, Instagram bio and the card in every parcel. It opens WhatsApp with "Yes, send me offers"; when they send it, they're added.</p>
            <div class="qr" aria-label="QR code">${g.link.qr}</div>
            <div class="link-box"><code>${escapeHtml(g.link.url)}</code></div>
            <div class="grow-actions">
              <button type="button" class="btn btn-small" data-copy>Copy link</button>
              <button type="button" class="btn btn-small" data-qr-download>Download QR</button>
              <button type="button" class="link-btn" data-change-number>Change number</button>
            </div>`
          : ''}
        <div class="number-form ${g.link.url ? 'hidden' : ''}" data-number-form>
          <p>Your WhatsApp business number (the one customers message):</p>
          <div class="row-fields"><input class="plain-input" data-number value="${escapeHtml(g.link.number)}" placeholder="e.g. 98765 43210" inputmode="tel" /><button type="button" class="btn btn-small btn-dark" data-number-save>Save</button></div>
        </div>
      </div>
    </div>`;
  const q = (s) => card.querySelector(s);
  q('[data-grow-close]').addEventListener('click', () => {
    list.growOpen = false;
    renderGrow();
  });
  wireImport(card);
  const checkoutBtn = q('[data-checkout]');
  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', async () => {
      const reason = prompt(`Add the ${g.checkoutConsent.toLocaleString('en-IN')} people who ticked the WhatsApp box at checkout to offers?\n\nOnly if that box asks customers to get offers on WhatsApp. Anyone who replied STOP stays out.\n\nWhat does the box say? Saved as proof on each customer.`, 'Ticked the WhatsApp box at Magic Checkout');
      if (!reason || reason.trim().length < 3) return;
      try {
        const r = await post('/api/customers/grow/checkout', { confirm: true, reason: reason.trim() });
        toast(`${plural(r.changed, 'person', 'people')} added`);
        renderGrow();
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  const saveNumber = async () => {
    try {
      await put('/api/customers/grow/link', { number: q('[data-number]').value });
      renderGrow();
    } catch (err) {
      toast(err.message);
    }
  };
  q('[data-number-save]').addEventListener('click', saveNumber);
  q('[data-number]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNumber();
  });
  const copy = q('[data-copy]');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(g.link.url);
        toast('Link copied');
      } catch (err) {
        toast("Couldn't copy. Press and hold the link to copy it.");
      }
    });
    q('[data-qr-download]').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([g.link.qr], { type: 'image/svg+xml' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'thakar-kitchen-offers-qr.svg' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    q('[data-change-number]').addEventListener('click', () => q('[data-number-form]').classList.remove('hidden'));
  }
}

function wireImport(card) {
  const q = (s) => card.querySelector(s);
  const result = q('[data-import-result]');
  let csv = '';
  let fileName = '';
  const preview = async () => {
    if (!csv) return;
    result.innerHTML = '<div class="muted">Reading the file…</div>';
    const optIn = q('[data-import-optin]').checked;
    try {
      const r = await post('/api/customers/import', { csv, optIn, tag: q('[data-import-tag]').value, dryRun: true });
      const lines = [
        `Found <b>${plural(r.people, 'phone number')}</b> in the column "${escapeHtml(r.columns.phone)}"${r.columns.name ? `, names from "${escapeHtml(r.columns.name)}"` : ''}.`,
        r.newCustomers === r.people
          ? 'All of them are new customers.'
          : `${plural(r.newCustomers, 'new customer')}; ${(r.people - r.newCustomers).toLocaleString('en-IN')} already here.`,
      ];
      if (r.invalid || r.duplicates) lines.push(`Skipped ${r.invalid ? plural(r.invalid, 'row') + ' without a usable number' : ''}${r.invalid && r.duplicates ? ' and ' : ''}${r.duplicates ? plural(r.duplicates, 'repeat') : ''}.`);
      if (optIn) {
        lines.push(`<b>${plural(r.willOptIn, 'person', 'people')}</b> will get offers.`);
        if (r.columns.optIn) lines.push(`Only rows marked yes in "${escapeHtml(r.columns.optIn)}" are added to offers (${r.notAgreed.toLocaleString('en-IN')} marked no).`);
        if (r.alreadyOptedIn) lines.push(`${plural(r.alreadyOptedIn, 'person', 'people')} already get offers.`);
        if (r.stopped) lines.push(`${plural(r.stopped, 'person', 'people')} replied STOP before and stay out.`);
      }
      result.innerHTML = `<div class="import-preview">${lines.map((l) => `<p>${l}</p>`).join('')}<button type="button" class="btn btn-small btn-primary" data-import-go>Import ${plural(r.people, 'person', 'people')}</button></div>`;
      result.querySelector('[data-import-go]').addEventListener('click', async (e) => {
        const reason = q('[data-import-reason]').value.trim();
        if (optIn && reason.length < 3) return toast('Say where they agreed (saved as proof on each customer)');
        if (optIn && !confirm('Confirm these people agreed to get offers from Thakar Kitchen on WhatsApp?')) return;
        e.target.disabled = true;
        e.target.textContent = 'Importing…';
        try {
          const done = await post('/api/customers/import', { csv, optIn, confirm: optIn, reason, fileName, tag: q('[data-import-tag]').value, dryRun: false });
          toast(`Imported. ${plural(done.newCustomers, 'new customer')}${optIn ? `, ${plural(done.willOptIn, 'person', 'people')} added to offers` : ''}.`);
          csv = '';
          renderGrow();
          refresh();
        } catch (err) {
          toast(err.message);
          e.target.disabled = false;
        }
      });
    } catch (err) {
      result.innerHTML = `<p class="warn">${escapeHtml(err.message)}</p>`;
    }
  };
  q('[data-file]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    q('[data-file-name]').textContent = file.name;
    fileName = file.name;
    if (file.size > 7 * 1024 * 1024) {
      result.innerHTML = '<p class="warn">That file is too big (over 7 MB). Export only the name and phone columns.</p>';
      return;
    }
    csv = await file.text();
    preview();
  });
  q('[data-import-optin]').addEventListener('change', (e) => {
    q('[data-import-reason]').classList.toggle('hidden', !e.target.checked);
    preview();
  });
}

// ---------- Refresh & detail ----------
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
    `${plural(d.totals.customers, 'customer')} · ${d.totals.optedIn.toLocaleString('en-IN')} get offers. ${syncNote(d)}`;
  renderSegments();
  renderFilterRow();
  // Not while typing in it (the new list is already what it shows).
  const card = el('view-customers').querySelector('[data-filter-card]');
  if (list.filtersOpen && !card.contains(document.activeElement)) renderFilterCard();
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
