// Automations: the messages that go out by themselves, each with an on/off
// switch, a preview, what it costs and how it's doing.
import { state, api, post, patch, put, el, escapeHtml, ago, money, toast, ico, isCurrent, switchHtml, plural } from './core.js';

let data = null;

const CARDS = [
  {
    id: 'orders',
    icon: 'box',
    title: 'Order updates',
    desc: 'Tells customers when their order is confirmed, shipped (with the India Post tracking link), out for delivery and delivered.',
    keys: [
      ['order_confirmed', 'Order confirmed'],
      ['order_shipped', 'Shipped, with tracking link'],
      ['order_out_for_delivery', 'Out for delivery'],
      ['order_delivered', 'Delivered'],
    ],
    previewKey: 'order_shipped',
  },
  {
    id: 'cod',
    icon: 'wallet',
    title: 'COD confirmation',
    desc: 'Cash-on-delivery orders (including Razorpay part-COD) get Confirm / Cancel buttons before you ship. Answers are tagged on the order in Shopify.',
    keys: [['cod_confirmation', 'Ask COD customers to confirm']],
    previewKey: 'cod_confirmation',
  },
  {
    id: 'cart',
    icon: 'cart',
    title: 'Abandoned cart',
    desc: 'One reminder a while after someone leaves Magic Checkout, with a link that reopens their order in Magic Checkout. Only for customers who said yes to WhatsApp messages at checkout, or opted in to offers.',
    keys: [['abandoned_cart', 'Send cart reminders']],
    previewKey: 'abandoned_cart',
    option: { key: 'abandoned_cart', name: 'delayMinutes', label: 'Send after', choices: [[30, '30 minutes'], [60, '1 hour'], [180, '3 hours'], [360, '6 hours']] },
  },
  {
    id: 'reorder',
    icon: 'repeat',
    title: 'Reorder reminders',
    desc: "A nudge some days after an order ships, naming what they bought. Skipped if they've ordered again. Opted-in customers only, at most one a month.",
    keys: [['reorder_reminder', 'Send reorder reminders']],
    previewKey: 'reorder_reminder',
    option: { key: 'reorder_reminder', name: 'days', label: 'Days after shipping', choices: [[14, '14 days'], [21, '21 days'], [30, '30 days'], [45, '45 days']] },
  },
  {
    id: 'stock',
    icon: 'bell',
    title: 'Back-in-stock alerts',
    desc: "When a customer asks about something sold out, add it on their profile. They get a message as soon as it's back in Shopify.",
    keys: [['back_in_stock', 'Send back-in-stock alerts']],
    previewKey: 'back_in_stock',
  },
];

function templatePill(t) {
  if (!t) return '<span class="pill pill-red">Template missing</span>';
  if (t.status === 'APPROVED' || data.testMode) return `<span class="pill ${t.status === 'APPROVED' ? 'pill-green' : 'pill-amber'}">${escapeHtml(t.statusLabel)}</span>`;
  if (t.status === 'PENDING') return '<span class="pill pill-amber">Waiting for Meta</span>';
  if (t.status === 'REJECTED') return '<span class="pill pill-red">Rejected by Meta</span>';
  return `<span class="pill">${escapeHtml(t.statusLabel)}</span>`;
}

function statsLine(card) {
  const a = data.automations;
  const s = (key) => (a[key] && a[key].stats) || {};
  switch (card.id) {
    case 'orders': {
      const sent = card.keys.reduce((n, [k]) => n + (s(k).sent || 0), 0);
      return `${plural(sent, 'update')} sent this week`;
    }
    case 'cod': {
      const c = s('cod_confirmation');
      return `This week: ${c.confirmed || 0} confirmed · ${c.cancelRequested || 0} want to cancel · ${c.waiting || 0} waiting <a href="#/orders">See COD orders</a>`;
    }
    case 'cart': {
      const c = s('abandoned_cart');
      const left = c.abandonedThisWeek != null ? `${c.abandonedThisWeek.toLocaleString('en-IN')} carts left in Shopify this week · ` : '';
      return `${left}${plural(c.sent || 0, 'reminder')} sent · ${plural(c.recovered || 0, 'order')} recovered${c.recoveredValue ? ` (${money(c.recoveredValue)})` : ''}`;
    }
    case 'reorder': {
      const c = s('reorder_reminder');
      return `${plural(c.sent || 0, 'reminder')} sent this week · ${plural(c.reordered || 0, 'customer')} reordered (30 days)`;
    }
    case 'stock': {
      const c = s('back_in_stock');
      return `${plural(c.waiting || 0, 'customer')} waiting · ${c.sent || 0} told this week`;
    }
    default:
      return '';
  }
}

function previewHtml(t) {
  if (!t) return '';
  const buttons = (t.quickReplies || []).concat((t.urlButtons || []).map((b) => b.text));
  return `
    <div class="wa-preview">
      <div class="wa-bubble">${escapeHtml(t.preview)}</div>
      ${buttons.length ? `<div class="wa-buttons">${buttons.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function cardHtml(card) {
  const a = data.automations;
  const first = a[card.keys[0][0]];
  const marketing = first.marketing;
  const t = a[card.previewKey].template;
  const cost = marketing
    ? `About ${money(first.cost)} per message incl. GST (Meta's marketing rate)`
    : `About ${money(first.cost)} per message incl. GST, free if they messaged you in the last 24 hours`;
  const toggles = card.keys
    .map(([key, label]) => {
      const auto = a[key];
      return `<label class="auto-toggle">
        <span>${escapeHtml(label)}${card.keys.length > 1 ? ` <small>${auto.stats.sent || 0} this week</small>` : ''}</span>
        ${templatePill(auto.template)}
        ${switchHtml(`auto-${key}`, auto.enabled, label)}
      </label>`;
    })
    .join('');
  const opt = card.option
    ? `<label class="auto-option"><span>${escapeHtml(card.option.label)}</span>
        <select data-option="${card.option.key}:${card.option.name}">
          ${card.option.choices.map(([v, l]) => `<option value="${v}" ${a[card.option.key].options[card.option.name] === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
        </select></label>`
    : '';
  const submit =
    data.metaReady && t && ['not_submitted', 'REJECTED'].includes(t.status)
      ? `<button type="button" class="link-btn" data-submit="${t._id}">Submit template to Meta</button>`
      : '';
  const rejected = t && t.status === 'REJECTED' && t.rejectedReason ? `<p class="warn">Meta's reason: ${escapeHtml(t.rejectedReason)}</p>` : '';
  const delivered = card.id === 'orders'
    ? '<p class="card-note">"Out for delivery" and "Delivered" only go out if your courier updates Shopify with delivery status.</p>'
    : '';
  return `
    <article class="auto-card">
      <div class="auto-head"><span class="auto-icon">${ico(card.icon)}</span><h2>${escapeHtml(card.title)}</h2></div>
      <p class="auto-desc">${escapeHtml(card.desc)}</p>
      <div class="auto-toggles">${toggles}</div>
      ${opt}
      ${previewHtml(t)}
      ${delivered}
      ${rejected}
      <div class="auto-foot">
        <span class="auto-stats">${statsLine(card)}</span>
        <span class="muted">${escapeHtml(cost)}</span>
        ${submit}
      </div>
    </article>`;
}

function statusStrip() {
  const whatsapp = data.testMode
    ? '<span class="pill pill-amber">Test mode</span> Messages show in chats but nothing is sent on WhatsApp.'
    : data.whatsappConnected
    ? '<span class="pill pill-green">WhatsApp connected</span>'
    : '<span class="pill pill-red">WhatsApp not connected</span>';
  const orders = data.sync.orders;
  const shopify = !data.shopifyConnected
    ? '<span class="pill pill-red">Shopify not connected</span>'
    : `Orders checked ${orders.lastRunAt ? `${escapeHtml(ago(orders.lastRunAt))} ago` : 'soon'}${orders.lastError ? ` <span class="warn">(last check failed: ${escapeHtml(orders.lastError)})</span>` : ''}
       <button type="button" class="link-btn" data-run="orders">${orders.running ? 'Checking…' : 'Check now'}</button>`;
  const catalog = Object.values(data.automations).map((a) => a.template).filter(Boolean);
  const approved = catalog.filter((t) => t.status === 'APPROVED').length;
  const templatesLine = data.testMode
    ? 'Message templates: submitted to Meta for approval once WhatsApp is connected.'
    : data.metaReady
    ? `${approved} of ${catalog.length} message templates approved by Meta. <button type="button" class="link-btn" data-refresh>Refresh</button> <button type="button" class="link-btn" data-submit-all>Submit all to Meta</button>`
    : 'Add WHATSAPP_BUSINESS_ACCOUNT_ID in Render to submit templates and see their approval here.';
  return `
    <section class="status-strip">
      <div>${ico('chat')}<span>${whatsapp}</span></div>
      <div>${ico('box')}<span>${shopify}</span></div>
      <div>${ico('check')}<span>${templatesLine}</span></div>
      <div>${ico('clock')}<span>Offers and reminders are never sent at night (9pm to 9am).</span></div>
    </section>`;
}

function optInCard() {
  const o = data.optInFromShopify;
  return `
    <article class="auto-card optin-card">
      <div class="auto-head"><span class="auto-icon">${ico('users')}</span><h2>Who gets offers</h2></div>
      <p class="auto-desc">WhatsApp only allows offers, reminders and campaigns to people who agreed to get them. Right now <b>${plural(o.optedIn, 'customer')}</b> ${o.optedIn === 1 ? 'has' : 'have'} opted in.</p>
      <label class="auto-toggle">
        <span>Count customers who accepted marketing at checkout <small>${plural(o.subscribed, 'customer')} in Shopify</small></span>
        ${switchHtml('optin-shopify', o.enabled, 'Count customers who accepted marketing at checkout')}
      </label>
      <p class="card-note">Only turn this on if your checkout asks customers to get offers on WhatsApp or SMS. Customers can always reply <b>STOP</b> to stop offers, or <b>START</b> to get them again. You can also opt people in one by one on their profile, or a whole group on the Customers page.</p>
    </article>`;
}

function aiCard() {
  const ai = data.ai || {};
  return `
    <article class="auto-card">
      <div class="auto-head"><span class="auto-icon">${ico('spark')}</span><h2>Instant replies & AI answers</h2></div>
      <p class="auto-desc">Always on. Order-status questions are answered from Shopify, problems become tickets, and everything else gets an answer from your website info or an instant acknowledgment.</p>
      <div class="auto-toggles"><div class="auto-toggle"><span>AI answers</span><span class="pill ${ai.enabled ? 'pill-green' : ''}">${ai.enabled ? `On · ${escapeHtml(ai.model || ai.provider)}` : 'Off: add AI_API_KEY in Render'}</span></div></div>
      <div class="auto-foot"><span class="muted">Replies inside the 24-hour window are free.</span>${state.config.testMode ? '<a href="#/test">Try it on the Test page</a>' : ''}</div>
    </article>`;
}

function render() {
  const view = el('view-automations');
  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Automations</h1>
          <p class="page-sub">Messages that go out by themselves. Everything is off until you switch it on, and each one only acts on things that happen after that.</p>
        </div>
      </header>
      ${statusStrip()}
      <div class="auto-grid">
        ${CARDS.map(cardHtml).join('')}
        ${aiCard()}
        ${optInCard()}
      </div>
    </div>`;

  for (const input of view.querySelectorAll('input[id^="auto-"]')) {
    input.addEventListener('change', async () => {
      const key = input.id.slice(5);
      try {
        const r = await patch(`/api/automations/${key}`, { enabled: input.checked });
        data.automations[key] = { ...data.automations[key], ...r };
        if (input.checked && data.automations[key].marketing && data.optInFromShopify.optedIn === 0) {
          toast('Switched on. No one has opted in to offers yet, so nothing will go out until they do. See "Who gets offers".');
        } else {
          toast(input.checked ? 'Switched on' : 'Switched off');
        }
      } catch (err) {
        input.checked = !input.checked;
        toast(`Not changed: ${err.message}`);
      }
    });
  }
  for (const sel of view.querySelectorAll('[data-option]')) {
    sel.addEventListener('change', async () => {
      const [key, name] = sel.dataset.option.split(':');
      try {
        await patch(`/api/automations/${key}`, { options: { [name]: Number(sel.value) } });
        toast('Saved');
      } catch (err) {
        toast(`Not saved: ${err.message}`);
      }
    });
  }
  const optin = view.querySelector('#optin-shopify');
  optin.addEventListener('change', async () => {
    if (optin.checked && !confirm('Count everyone who accepted marketing at checkout as opted in to WhatsApp offers?\n\nOnly do this if your checkout asks customers to get offers on WhatsApp or SMS.')) {
      optin.checked = false;
      return;
    }
    try {
      const r = await put('/api/automations/optin-shopify', { enabled: optin.checked });
      toast(`${plural(r.changed, 'customer')} ${optin.checked ? 'opted in' : 'opted out'}`);
      load();
    } catch (err) {
      optin.checked = !optin.checked;
      toast(err.message);
    }
  });
  const run = view.querySelector('[data-run]');
  if (run) {
    run.addEventListener('click', async () => {
      run.textContent = 'Checking…';
      run.disabled = true;
      try {
        const r = await post('/api/automations/run', { job: run.dataset.run });
        toast(r && r.error ? `Check failed: ${r.error}` : r && r.stillRunning ? 'Still checking in the background' : 'Checked');
      } catch (err) {
        toast(err.message);
      }
      load();
    });
  }
  for (const b of view.querySelectorAll('[data-submit]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await post(`/api/templates/${b.dataset.submit}/submit`);
        toast('Sent to Meta for approval. This usually takes a few minutes to a day.');
        load();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    });
  }
  const refresh = view.querySelector('[data-refresh]');
  if (refresh) {
    refresh.addEventListener('click', async () => {
      try {
        await post('/api/templates/refresh');
        load();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  const submitAll = view.querySelector('[data-submit-all]');
  if (submitAll) {
    submitAll.addEventListener('click', async () => {
      try {
        const r = await post('/api/templates/submit-all');
        const failed = r.results.filter((x) => !x.ok);
        toast(failed.length ? `${failed.length} not accepted: ${failed[0].error}` : `${r.results.length} sent to Meta for approval`);
        load();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

export async function load() {
  try {
    data = await api('/api/automations');
  } catch (err) {
    el('view-automations').innerHTML = `<div class="page"><div class="empty"><b>Couldn't load</b>${escapeHtml(err.message)}</div></div>`;
    return;
  }
  if (isCurrent('automations')) render();
}

export function showAutomations() {
  if (!el('view-automations').innerHTML) el('view-automations').innerHTML = '<div class="page"><div class="empty">Loading…</div></div>';
  return load();
}
