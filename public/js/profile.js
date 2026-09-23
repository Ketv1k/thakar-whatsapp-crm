// The customer profile, shown next to a chat and on the Customers page:
// orders (with COD answers), tags, tickets, back-in-stock requests, the
// founder's note and the offers opt-in.
import {
  api, post, patch, del, el, escapeHtml, formatPhone, avatar, ago, money, toast, icon, ico,
  ISSUE_LABELS, switchHtml, shortDate,
} from './core.js';


const FULFIL = {
  UNFULFILLED: ['Not shipped yet', 'pill-amber'],
  PARTIALLY_FULFILLED: ['Partly shipped', 'pill-amber'],
  FULFILLED: ['Shipped', 'pill-green'],
  RESTOCKED: ['Returned', 'pill-red'],
  IN_PROGRESS: ['Packing', 'pill-amber'],
  ON_HOLD: ['On hold', 'pill-red'],
  SCHEDULED: ['Scheduled', 'pill-amber'],
};

const COD_LABELS = {
  awaiting: ['COD: waiting for customer', 'pill-amber'],
  confirmed: ['COD confirmed', 'pill-green'],
  cancel_requested: ['Wants to cancel', 'pill-red'],
};

const OPTIN_SOURCES = {
  manual: 'turned on by you',
  keyword: 'they replied START',
  bulk: 'added in a group opt-in',
  shopify: 'agreed at checkout (Shopify)',
};

let knownTags = [];

/**
 * Renders a profile into `container`.
 * opts: { conversationId, showChatLink, onTagsChanged }
 */
export function renderProfile(container, p, opts = {}) {
  const s = p.shopify || { found: false };
  const name = p.name || formatPhone(p.phone);
  const statusPill = p.status === 'vip' ? 'pill-vip' : p.status === 'returning' ? 'pill-green' : '';
  // Shopify's orders, plus any the app knows that Shopify didn't list
  // (test orders in test mode, or everything when Shopify can't be reached).
  const shopifyNames = new Set((s.orders || []).map((o) => o.name));
  const allOrders = [...(s.orders || []), ...(p.localOrders || []).filter((o) => !shopifyNames.has(o.name))]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 6);
  const orders = allOrders
    .map((o) => {
      const [label, cls] = FULFIL[o.fulfillmentStatus] || ['Processing', 'pill-amber'];
      const cod = p.cod && p.cod[o.name];
      const codPill = cod && COD_LABELS[cod.status] ? `<span class="pill ${COD_LABELS[cod.status][1]}">${COD_LABELS[cod.status][0]}</span>` : '';
      const codAction =
        cod && cod.status === 'awaiting'
          ? `<button type="button" class="link-btn" data-cod-confirm="${escapeHtml(cod._id)}">Mark confirmed</button>`
          : '';
      return `<div class="box-row"><span><b>${escapeHtml(o.name)}</b>${o.simulated ? ' <span class="pill">test</span>' : ''}<div class="sub">${escapeHtml(shortDate(o.createdAt))} · ${money(o.total, s.currency || o.currency)}</div></span>
        <span class="row-pills"><span class="pill ${cls}">${escapeHtml(label)}</span>${codPill}${codAction}</span></div>`;
    })
    .join('');
  const tickets = (p.tickets || [])
    .map((t) => {
      const [label, cls] = t.status === 'resolved' ? ['Resolved', 'pill-green'] : t.status === 'open' ? ['Open', 'pill-red'] : ['You replied', 'pill-amber'];
      return `<div class="box-row"><span>#${t.ticketNumber} · ${escapeHtml(ISSUE_LABELS[t.issueType] || t.issueType)}</span><span class="pill ${cls}">${label}</span></div>`;
    })
    .join('');
  const optinNote = p.optedInMarketing
    ? `Yes: ${escapeHtml(OPTIN_SOURCES[p.optInSource] || 'opted in')}`
    : p.optedOutAt
    ? `No: stopped ${escapeHtml(ago(p.optedOutAt))} ago`
    : 'Not yet. Only opted-in customers get offers and campaigns.';

  container.innerHTML = `
    <div class="cust-top">
      ${avatar({ phone: p.phone, name })}
      <div>
        <h2 class="cust-name">${escapeHtml(name)}</h2>
        <div class="cust-phone">${escapeHtml(formatPhone(p.phone))}${p.city ? ` · ${escapeHtml(p.city)}` : ''}</div>
        <span class="pill ${statusPill}" style="margin-top:4px">${escapeHtml(p.statusLabel || 'New customer')}</span>
      </div>
    </div>
    ${opts.showChatLink
      ? p.conversationId
        ? `<a class="btn btn-primary btn-block" href="#/inbox/${p.conversationId}">${ico('chat')}Open chat</a>`
        : '<p class="muted">No WhatsApp chat with this customer yet.</p>'
      : ''}
    <div class="stats">
      <div class="stat"><b>${s.ordersCount != null ? s.ordersCount : 0}</b><span>orders</span></div>
      <div class="stat"><b>${money(s.totalSpent || 0, s.currency)}</b><span>spent</span></div>
      <div class="stat"><b>${s.lastOrderAt ? escapeHtml(ago(s.lastOrderAt)) : '—'}</b><span>last order</span></div>
    </div>
    <section>
      <h3 class="section-title">Orders</h3>
      <div class="box">${orders || (p.shopifyConnected === false ? '<div class="box-empty">Shopify isn\'t connected.</div>' : s.error && !s.fromSync ? '<div class="box-empty">Couldn\'t reach Shopify right now.</div>' : '<div class="box-empty">No orders for this number.</div>')}</div>
    </section>
    <section>
      <h3 class="section-title">Tags</h3>
      <div class="tags" data-tags></div>
    </section>
    <section>
      <h3 class="section-title">Tickets</h3>
      <div class="box">${tickets || '<div class="box-empty">No problems reported.</div>'}</div>
    </section>
    <section>
      <h3 class="section-title">Waiting for a restock</h3>
      <div data-stock></div>
    </section>
    <section>
      <h3 class="section-title">Your note</h3>
      <textarea class="note" data-note placeholder="e.g. Prefers less spicy · orders for her parents every month" aria-label="Private note about this customer">${escapeHtml(p.notes || '')}</textarea>
      <div class="note-row"><button type="button" class="btn btn-small" data-note-save>Save note</button><span class="hidden" data-note-saved>Saved</span></div>
    </section>
    <label class="optin">
      <span>Gets offers on WhatsApp<small data-optin-note>${optinNote}</small></span>
      ${switchHtml(`optin-${p.phone}-${Math.random().toString(36).slice(2, 7)}`, p.optedInMarketing, 'Gets offers on WhatsApp')}
    </label>`;

  const q = (sel) => container.querySelector(sel);

  for (const b of container.querySelectorAll('[data-cod-confirm]')) {
    b.addEventListener('click', async () => {
      try {
        await post(`/api/orders/${b.dataset.codConfirm}/cod`, { status: 'confirmed' });
        toast('Marked as confirmed');
        b.closest('.row-pills').innerHTML = '<span class="pill pill-green">COD confirmed</span>';
      } catch (err) {
        toast(`Not updated: ${err.message}`);
      }
    });
  }

  renderTags(q('[data-tags]'), p, opts);
  renderStockAlerts(q('[data-stock]'), p);

  const note = q('[data-note]');
  let savedNote = p.notes || '';
  const saveNote = async () => {
    if (note.value === savedNote) return;
    try {
      await patch(`/api/customers/${p.phone}`, { notes: note.value });
      savedNote = note.value;
      p.notes = note.value;
      const saved = q('[data-note-saved]');
      if (saved) {
        saved.classList.remove('hidden');
        setTimeout(() => saved.classList.add('hidden'), 2000);
      }
    } catch (err) {
      toast(`Note not saved: ${err.message}`);
    }
  };
  q('[data-note-save]').addEventListener('click', saveNote);
  note.addEventListener('blur', saveNote);

  // (Scoped to this container: the same customer can be open in the inbox
  // panel and on the Customers page at once.)
  q('.optin input[type="checkbox"]').addEventListener('change', async (e) => {
    try {
      const res = await patch(`/api/customers/${p.phone}`, { optedInMarketing: e.target.checked });
      p.optedInMarketing = res.optedInMarketing;
      p.optInSource = res.optInSource;
      const noteEl = q('[data-optin-note]');
      if (noteEl) noteEl.textContent = res.optedInMarketing ? 'Yes: turned on by you' : 'No: turned off by you';
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`Not updated: ${err.message}`);
    }
  });
}

function renderTags(box, p, opts) {
  box.innerHTML =
    (p.tags || [])
      .map((t) => `<span class="tag">${escapeHtml(t)}<button type="button" data-remove="${escapeHtml(t)}" aria-label="Remove tag ${escapeHtml(t)}">${ico('close')}</button></span>`)
      .join('') + '<button type="button" class="add-tag" data-add-tag>+ Add tag</button>';

  const save = async (tags) => {
    try {
      const res = await patch(`/api/customers/${p.phone}`, { tags });
      p.tags = res.tags;
      renderTags(box, p, opts);
      if (opts.onTagsChanged) opts.onTagsChanged();
    } catch (err) {
      toast(`Tags not saved: ${err.message}`);
      renderTags(box, p, opts);
    }
  };
  for (const b of box.querySelectorAll('[data-remove]')) {
    b.addEventListener('click', () => save(p.tags.filter((t) => t !== b.dataset.remove)));
  }
  box.querySelector('[data-add-tag]').addEventListener('click', async (e) => {
    const input = document.createElement('input');
    input.className = 'tag-input';
    input.placeholder = 'e.g. Jain, Monthly';
    input.setAttribute('aria-label', 'New tag');
    input.setAttribute('list', 'tag-suggestions');
    input.maxLength = 30;
    e.currentTarget.replaceWith(input);
    input.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v) save([...(p.tags || []), v]);
      else renderTags(box, p, opts);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') {
        done = true;
        renderTags(box, p, opts);
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

const ALERT_STATUS = {
  waiting: ['Waiting', 'pill-amber'],
  sent: ['Told them', 'pill-green'],
  failed: ['Not sent', 'pill-red'],
};

function renderStockAlerts(box, p) {
  const rows = (p.stockAlerts || [])
    .map((a) => {
      const [label, cls] = ALERT_STATUS[a.status] || [a.status, ''];
      const title = a.variantTitle ? `${a.productTitle} (${a.variantTitle})` : a.productTitle;
      return `<div class="box-row"><span>${escapeHtml(title)}<div class="sub">${a.status === 'sent' ? `sent ${escapeHtml(ago(a.sentAt))} ago` : `asked ${escapeHtml(ago(a.createdAt))} ago`}</div></span>
        <span class="row-pills"><span class="pill ${cls}">${label}</span>${a.status === 'waiting' ? `<button type="button" class="link-btn" data-cancel-alert="${a._id}">Remove</button>` : ''}</span></div>`;
    })
    .join('');
  box.innerHTML = `
    <div class="box">${rows || '<div class="box-empty">Nothing yet. Add a product they asked about and they get a WhatsApp message when it\'s back.</div>'}</div>
    <div class="stock-add">
      <label class="search small"><span class="ico">${icon('search')}</span><input type="search" placeholder="Find a product, e.g. methi papad" aria-label="Find a product" data-product-q /></label>
      <div class="product-results" data-product-results></div>
    </div>`;

  for (const b of box.querySelectorAll('[data-cancel-alert]')) {
    b.addEventListener('click', async () => {
      try {
        await del(`/api/stock-alerts/${b.dataset.cancelAlert}`);
        p.stockAlerts = p.stockAlerts.filter((a) => a._id !== b.dataset.cancelAlert);
        renderStockAlerts(box, p);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  const input = box.querySelector('[data-product-q]');
  const results = box.querySelector('[data-product-results]');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      results.innerHTML = '<div class="muted">Searching…</div>';
      try {
        const products = await api(`/api/products?q=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return;
        if (!products.length) {
          results.innerHTML = '<div class="muted">No products found.</div>';
          return;
        }
        results.innerHTML = products
          .map((prod) => {
            const options = prod.variants.length > 1 || (prod.variants[0] && prod.variants[0].title)
              ? prod.variants
                  .map((v) => `<button type="button" class="chip-btn ${v.available ? '' : 'sold-out'}" data-pid="${escapeHtml(prod.id)}" data-vid="${escapeHtml(v.id)}">${escapeHtml(v.title)}${v.available ? '' : ' · sold out'}</button>`)
                  .join('')
              : `<button type="button" class="chip-btn ${prod.inStock ? '' : 'sold-out'}" data-pid="${escapeHtml(prod.id)}">${prod.inStock ? 'In stock' : 'Sold out'} · notify</button>`;
            return `<div class="product-row"><b>${escapeHtml(prod.title)}</b><div class="product-options">${options}</div></div>`;
          })
          .join('');
        for (const b of results.querySelectorAll('[data-pid]')) {
          b.addEventListener('click', async () => {
            try {
              const alert = await post('/api/stock-alerts', { phone: p.phone, productId: b.dataset.pid, variantId: b.dataset.vid || null });
              p.stockAlerts = [alert, ...(p.stockAlerts || []).filter((a) => a._id !== alert._id)];
              toast(b.classList.contains('sold-out') ? "Added. They'll get a message when it's back." : "Added. It's in stock now, so they'll get the message at the next check.");
              renderStockAlerts(box, p);
            } catch (err) {
              toast(err.message);
            }
          });
        }
      } catch (err) {
        results.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
      }
    }, 300);
  });
}

export async function loadProfile(phone) {
  return api(`/api/customers/${phone}`);
}
