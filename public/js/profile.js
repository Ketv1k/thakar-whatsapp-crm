// The customer profile, shown next to a chat and on the Customers page:
// orders (with COD answers), tags, tickets, back-in-stock requests, the
// founder's note and the offers opt-in.
import {
  api, post, patch, del, el, escapeHtml, formatPhone, avatar, ago, money, toast, icon, ico,
  ISSUE_LABELS, switchHtml, shortDate, plural, STAGE_PILLS,
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
  import: 'from a list you imported',
  checkout: 'ticked WhatsApp at checkout',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// What their orders say about them, in plain sentences.
function glanceRows(p) {
  const i = p.insights || {};
  const rows = [];
  if (i.avgOrder) rows.push(['Usual order', money(i.avgOrder)]);
  if (i.avgGapDays) {
    let next = '';
    if (i.nextOrderAt) {
      const days = Math.round((new Date(i.nextOrderAt).getTime() - Date.now()) / 86400000);
      next = days >= 0 ? ` · next one due around ${shortDate(i.nextOrderAt)}` : ` · ${plural(-days, 'day')} late`;
    }
    rows.push(['Orders', `about every ${plural(i.avgGapDays, 'day')}${next}`]);
  }
  if (i.codOrders || i.prepaidOrders) {
    const cancelled = i.codCancelled ? ` · <span class="warn-text">${plural(i.codCancelled, 'COD order')} cancelled</span>` : '';
    rows.push(['Pays', `${escapeHtml(`online ${i.prepaidOrders} · COD ${i.codOrders}`)}${cancelled}`, true]);
  }
  if ((i.favourites || []).length) rows.push(['Buys most', i.favourites.join(', ')]);
  const place = [p.city, p.state, p.pincode].filter(Boolean).join(', ');
  if (place) rows.push(['Lives in', place]);
  return rows
    .map(([k, v, html]) => `<div class="glance-row"><span>${escapeHtml(k)}</span><b>${html ? v : escapeHtml(v)}</b></div>`)
    .join('');
}

function stagePillHtml(p) {
  if (p.stage && p.stageLabel) return `<span class="pill ${STAGE_PILLS[p.stage] || ''}" style="margin-top:4px">${escapeHtml(p.stageLabel)}</span>`;
  const statusPill = p.status === 'vip' ? 'pill-vip' : p.status === 'returning' ? 'pill-green' : '';
  return `<span class="pill ${statusPill}" style="margin-top:4px">${escapeHtml(p.statusLabel || 'New customer')}</span>`;
}

let knownTags = [];

/**
 * Renders a profile into `container`.
 * opts: { conversationId, showChatLink, onTagsChanged }
 */
export function renderProfile(container, p, opts = {}) {
  const s = p.shopify || { found: false };
  const name = p.name || formatPhone(p.phone);
  const glance = glanceRows(p);
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
        ${stagePillHtml(p)}
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
    ${glance ? `<div class="glance">${glance}</div>` : ''}
    <section>
      <h3 class="section-title">Remind me</h3>
      <div data-followup></div>
    </section>
    <section>
      <h3 class="section-title">Orders</h3>
      <div class="box">${orders || (p.shopifyConnected === false ? '<div class="box-empty">Shopify isn\'t connected.</div>' : s.error && !s.fromSync ? '<div class="box-empty">Couldn\'t reach Shopify right now.</div>' : '<div class="box-empty">No orders for this number.</div>')}</div>
    </section>
    <section>
      <h3 class="section-title">History</h3>
      <div data-history><div class="muted">Loading…</div></div>
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
    <section>
      <h3 class="section-title">Birthday</h3>
      <div data-birthday></div>
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
  renderFollowUp(q('[data-followup]'), p);
  renderBirthday(q('[data-birthday]'), p);
  loadHistory(q('[data-history]'), p.phone, 12);

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

// ---------- Reminder to follow up ----------
function inDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(10, 0, 0, 0);
  return d;
}

function dateInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderFollowUp(box, p) {
  if (p.followUpAt) {
    const due = new Date(p.followUpAt);
    const overdue = due.getTime() < Date.now();
    box.innerHTML = `
      <div class="followup ${overdue ? 'due' : ''}">
        <span><b>${overdue ? 'Due' : 'On'} ${escapeHtml(shortDate(due))}</b>${p.followUpNote ? `<span>${escapeHtml(p.followUpNote)}</span>` : ''}</span>
        <span class="row-pills"><button type="button" class="btn btn-small btn-ok" data-fu-done>${ico('check')}Done</button><button type="button" class="link-btn" data-fu-edit>Change</button></span>
      </div>`;
    box.querySelector('[data-fu-done]').addEventListener('click', () => saveFollowUp(box, p, null, ''));
    box.querySelector('[data-fu-edit]').addEventListener('click', () => followUpForm(box, p));
    return;
  }
  box.innerHTML = '<button type="button" class="add-tag" data-fu-add>+ Remind me to follow up</button>';
  box.querySelector('[data-fu-add]').addEventListener('click', () => followUpForm(box, p));
}

function followUpForm(box, p) {
  const current = p.followUpAt ? new Date(p.followUpAt) : inDays(1);
  box.innerHTML = `
    <div class="followup-form">
      <div class="quick-dates">
        <button type="button" class="chip-btn" data-days="1">Tomorrow</button>
        <button type="button" class="chip-btn" data-days="3">In 3 days</button>
        <button type="button" class="chip-btn" data-days="7">Next week</button>
        <input type="date" data-fu-date value="${dateInputValue(current)}" aria-label="Remind me on" />
      </div>
      <input class="plain-input" data-fu-note value="${escapeHtml(p.followUpNote || '')}" placeholder="What about? e.g. send the Diwali box price" maxlength="200" aria-label="What about" />
      <div class="note-row"><button type="button" class="btn btn-small btn-dark" data-fu-save>Save reminder</button><button type="button" class="link-btn" data-fu-cancel>Cancel</button></div>
      <p class="muted">It shows on Home under "Needs your attention" on that day.</p>
    </div>`;
  const dateInput = box.querySelector('[data-fu-date]');
  for (const b of box.querySelectorAll('[data-days]')) {
    b.addEventListener('click', () => (dateInput.value = dateInputValue(inDays(Number(b.dataset.days)))));
  }
  box.querySelector('[data-fu-cancel]').addEventListener('click', () => renderFollowUp(box, p));
  box.querySelector('[data-fu-save]').addEventListener('click', () => {
    if (!dateInput.value) return toast('Pick a date');
    const [y, m, d] = dateInput.value.split('-').map(Number);
    saveFollowUp(box, p, new Date(y, m - 1, d, 10, 0, 0), box.querySelector('[data-fu-note]').value);
  });
}

async function saveFollowUp(box, p, at, note) {
  try {
    const res = await patch(`/api/customers/${p.phone}`, { followUpAt: at ? at.toISOString() : null, followUpNote: note });
    p.followUpAt = res.followUpAt;
    p.followUpNote = res.followUpNote;
    toast(at ? `Reminder set for ${shortDate(at)}` : 'Done');
    renderFollowUp(box, p);
  } catch (err) {
    toast(`Not saved: ${err.message}`);
  }
}

// ---------- Birthday ----------
function renderBirthday(box, p) {
  if (p.birthday) {
    const [m, d] = p.birthday.split('-').map(Number);
    box.innerHTML = `<div class="box-row plain"><span>🎂 ${d} ${MONTHS[m - 1]}</span><button type="button" class="link-btn" data-bd-edit>Change</button></div>`;
    box.querySelector('[data-bd-edit]').addEventListener('click', () => birthdayForm(box, p));
    return;
  }
  box.innerHTML = '<button type="button" class="add-tag" data-bd-add>+ Add birthday</button>';
  box.querySelector('[data-bd-add]').addEventListener('click', () => birthdayForm(box, p));
}

function birthdayForm(box, p) {
  const [m, d] = p.birthday ? p.birthday.split('-').map(Number) : [0, 0];
  box.innerHTML = `
    <div class="row-fields">
      <select data-bd-day aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${d === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
      <select data-bd-month aria-label="Month"><option value="">Month</option>${MONTHS.map((name, i) => `<option value="${i + 1}" ${m === i + 1 ? 'selected' : ''}>${name}</option>`).join('')}</select>
    </div>
    <div class="note-row"><button type="button" class="btn btn-small btn-dark" data-bd-save>Save</button>${p.birthday ? '<button type="button" class="link-btn" data-bd-clear>Remove</button>' : ''}<button type="button" class="link-btn" data-bd-cancel>Cancel</button></div>`;
  const save = async (value) => {
    try {
      const res = await patch(`/api/customers/${p.phone}`, { birthday: value });
      p.birthday = res.birthday;
      renderBirthday(box, p);
    } catch (err) {
      toast(`Not saved: ${err.message}`);
    }
  };
  box.querySelector('[data-bd-save]').addEventListener('click', () => {
    const day = Number(box.querySelector('[data-bd-day]').value);
    const month = Number(box.querySelector('[data-bd-month]').value);
    if (!day || !month) return toast('Pick a day and a month');
    save(`${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  });
  const clear = box.querySelector('[data-bd-clear]');
  if (clear) clear.addEventListener('click', () => save(''));
  box.querySelector('[data-bd-cancel]').addEventListener('click', () => renderBirthday(box, p));
}

// ---------- History ----------
const HISTORY_ICONS = {
  order: 'box',
  cancel: 'close',
  chat: 'chat',
  campaign: 'megaphone',
  cart_link: 'cart',
  reminder: 'bell',
  cart: 'cart',
  ticket: 'alert',
  resolved: 'check',
  restock: 'refresh',
  optin: 'check',
  optout: 'close',
};

async function loadHistory(box, phone, limit) {
  try {
    const h = await api(`/api/customers/${phone}/timeline?limit=${limit}`);
    if (!box.isConnected) return;
    if (!h.events.length) {
      box.innerHTML = '<div class="box"><div class="box-empty">Nothing yet.</div></div>';
      return;
    }
    box.innerHTML = `
      <ol class="history">
        ${h.events
          .map(
            (e) => `<li class="h-${e.kind}"><span class="h-ico">${icon(HISTORY_ICONS[e.kind] || 'clock')}</span><span class="h-main"><span>${escapeHtml(e.text)}</span>${e.detail ? `<small>${escapeHtml(e.detail)}</small>` : ''}</span><time>${escapeHtml(shortDate(e.at))}</time></li>`
          )
          .join('')}
      </ol>
      ${h.more ? '<button type="button" class="link-btn" data-history-more>Show everything</button>' : ''}`;
    const more = box.querySelector('[data-history-more]');
    if (more) more.addEventListener('click', () => loadHistory(box, phone, 300));
  } catch (err) {
    box.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
  }
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
