// Campaigns: send an approved message to a group of opted-in customers, now or
// later, and see how it did.
import { state, api, post, patch, del, el, escapeHtml, dateTime, shortDate, money, toast, ico, isCurrent, plural, SEGMENT_LABELS } from './core.js';

let templatesCache = null;
let groupsCache = null;
let editing = null; // { campaign, estimate }
let viewingStatus = null;
let saveTimer = null;

const STATUS = {
  draft: ['Draft', ''],
  scheduled: ['Scheduled', 'pill-amber'],
  sending: ['Sending…', 'pill-amber'],
  sent: ['Sent', 'pill-green'],
  cancelled: ['Stopped', ''],
  failed: ['Stopped: problem', 'pill-red'],
};

function statusPill(status) {
  const [label, cls] = STATUS[status] || [status, ''];
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

// The stages people can pick as a campaign's group (the older groups stay
// readable for earlier campaigns).
const STAGE_KEYS = ['all', 'new', 'second_order', 'loyal', 'vip', 'at_risk', 'lost', 'no_orders'];

function hasFilters(a) {
  return !!(a && a.filters && Object.keys(a.filters).length);
}

function audienceLabel(a) {
  return `${a.label || SEGMENT_LABELS[a.segment] || 'Everyone'}${a.tag ? ` · ${a.tag}` : ''}`;
}

async function loadGroups() {
  try {
    groupsCache = await api('/api/customers/groups');
  } catch (err) {
    groupsCache = groupsCache || [];
  }
  return groupsCache;
}

// Stages, saved groups, and (when it came from the Customers page with
// filters) the group as it was picked there.
function audienceOptions(a) {
  const groups = groupsCache || [];
  const match = groups.find((g) => g.segment === a.segment && JSON.stringify(g.filters) === JSON.stringify(a.filters || {}));
  const custom = hasFilters(a) && !match;
  const selected = custom ? 'custom' : match && hasFilters(a) ? `group:${match._id}` : `stage:${a.segment}`;
  const opt = (value, label) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const stageKeys = STAGE_KEYS.includes(a.segment) ? STAGE_KEYS : [...STAGE_KEYS, a.segment];
  return (
    (custom ? opt('custom', `From Customers: ${a.label || 'your filters'}`) : '') +
    `<optgroup label="Stages">${stageKeys.map((k) => opt(`stage:${k}`, SEGMENT_LABELS[k] || k)).join('')}</optgroup>` +
    (groups.length ? `<optgroup label="Your groups">${groups.map((g) => opt(`group:${g._id}`, `★ ${g.name}`)).join('')}</optgroup>` : '')
  );
}

async function loadTemplates(force = false) {
  if (!templatesCache || force) templatesCache = (await api('/api/templates')).items;
  return templatesCache;
}

// ---------- List ----------
async function showList() {
  const view = el('view-campaigns');
  view.innerHTML = '<div class="page"><div class="empty">Loading…</div></div>';
  let list;
  try {
    list = await api('/api/campaigns');
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty"><b>Couldn't load campaigns</b>${escapeHtml(err.message)}</div></div>`;
    return;
  }
  if (!isCurrent('campaigns')) return;
  const rows = list
    .map((c) => {
      const when = c.status === 'scheduled' ? `Goes out ${dateTime(c.scheduledAt)}` : c.startedAt ? `Sent ${dateTime(c.startedAt)}` : `Draft from ${dateTime(c.createdAt)}`;
      const readPct = c.live.sent ? Math.round((c.live.read / c.live.sent) * 100) : 0;
      const earned = c.results && c.results.orders ? ` · ${plural(c.results.orders, 'order')}, ${money(c.results.revenue)}` : '';
      return `
        <a class="camp-row" href="#/campaigns/${c._id}">
          <span class="camp-main"><b>${escapeHtml(c.name)}</b><small>${escapeHtml(audienceLabel(c.audience))}${c.templateLabel ? ` · ${escapeHtml(c.templateLabel)}` : ''}</small></span>
          <span class="camp-when">${escapeHtml(when)}</span>
          <span class="camp-nums">${c.live.sent ? `${c.live.sent} sent · ${readPct}% read${earned}` : ''}</span>
          ${statusPill(c.status)}
        </a>`;
    })
    .join('');
  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Campaigns</h1>
          <p class="page-sub">Send an offer or a new launch to a group of customers who opted in to offers.</p>
        </div>
        <a class="btn btn-primary" href="#/campaigns/new">${ico('plus')}New campaign</a>
      </header>
      <section class="table-card">${rows || '<div class="empty"><b>No campaigns yet</b>Start one to send an approved message to a group, like everyone who hasn\'t ordered in 45 days.</div>'}</section>
    </div>`;
}

// ---------- New ----------
async function createAndOpen(query) {
  el('view-campaigns').innerHTML = '<div class="page"><div class="empty">Starting a new campaign…</div></div>';
  try {
    let filters = {};
    try {
      filters = JSON.parse(query.get('filters') || '{}');
    } catch (err) {
      /* ignore a bad link */
    }
    const label = query.get('label') || '';
    const c = await post('/api/campaigns', {
      name: label ? `Offer for ${label}`.slice(0, 80) : 'New campaign',
      audience: { segment: query.get('segment') || 'all', tag: query.get('tag') || '', filters, label },
    });
    location.replace(`#/campaigns/${c._id}`);
  } catch (err) {
    el('view-campaigns').innerHTML = `<div class="page"><div class="empty"><b>Couldn't start</b>${escapeHtml(err.message)}</div></div>`;
  }
}

// ---------- One campaign ----------
async function showOne(id) {
  const view = el('view-campaigns');
  view.innerHTML = '<div class="page"><div class="empty">Loading…</div></div>';
  let res;
  try {
    [res] = await Promise.all([api(`/api/campaigns/${id}`), loadTemplates(true), loadGroups()]);
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty"><b>Couldn't load</b>${escapeHtml(err.message)}</div></div>`;
    return;
  }
  if (!isCurrent('campaigns')) return;
  viewingStatus = res.campaign.status;
  if (['draft', 'scheduled'].includes(res.campaign.status)) {
    editing = { campaign: res.campaign, estimate: null };
    renderComposer();
    refreshEstimate();
  } else {
    renderResults(res);
  }
}

function currentTemplate() {
  const id = editing.campaign.templateId;
  return (templatesCache || []).find((t) => t._id === id) || null;
}

function sampleParams(t) {
  const out = [];
  for (let i = 0; i < t.paramCount; i++) {
    const p = (editing.campaign.bodyParams || [])[i];
    out.push(p && p.source === 'first_name' ? 'Priya' : (p && p.text) || `{{${i + 1}}}`);
  }
  return out;
}

function renderedPreview(t) {
  if (!t) return '<div class="wa-bubble muted">Choose a message to see it here.</div>';
  const params = sampleParams(t);
  const text = t.body.replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] || m);
  const buttons = (t.urlButtons || []).map((b) => b.text).concat(t.quickReplies || []);
  const image = t.headerFormat === 'IMAGE'
    ? editing.campaign.headerImageUrl
      ? `<img class="wa-image" src="${escapeHtml(editing.campaign.headerImageUrl)}" alt="Campaign photo" />`
      : '<div class="wa-image placeholder">Photo</div>'
    : '';
  return `<div class="wa-bubble">${image}${escapeHtml(text)}</div>${buttons.length ? `<div class="wa-buttons">${buttons.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>` : ''}`;
}

function paramsHtml(t) {
  if (!t || !t.paramCount) return '';
  const rows = [];
  for (let i = 0; i < t.paramCount; i++) {
    const p = (editing.campaign.bodyParams || [])[i] || { source: i === 0 ? 'first_name' : 'text', text: '' };
    rows.push(`
      <div class="param-row">
        <span class="param-n">{{${i + 1}}}</span>
        <select data-param-source="${i}" aria-label="Blank ${i + 1}">
          <option value="first_name" ${p.source === 'first_name' ? 'selected' : ''}>Customer's first name</option>
          <option value="text" ${p.source !== 'first_name' ? 'selected' : ''}>Same text for everyone</option>
        </select>
        <input data-param-text="${i}" value="${escapeHtml(p.text || '')}" placeholder="e.g. DIWALI10" ${p.source === 'first_name' ? 'hidden' : ''} aria-label="Text for blank ${i + 1}" />
      </div>`);
  }
  return `<div class="params"><span class="muted">Fill in the blanks:</span>${rows.join('')}</div>`;
}

function templateOptions() {
  // The automations' own templates have their own blanks (cart links etc.), so
  // campaigns use messages written for them.
  const usable = (templatesCache || []).filter((t) => t.source !== 'catalog');
  return usable
    .map((t) => {
      const ok = t.canSend;
      const note = ok ? '' : ` (${t.unsupported || t.statusLabel})`;
      return `<option value="${t._id}" ${t._id === editing.campaign.templateId ? 'selected' : ''} ${ok ? '' : 'disabled'}>${escapeHtml(t.label)}${escapeHtml(note)}</option>`;
    })
    .join('');
}

function localInputValue(date) {
  const d = date ? new Date(date) : new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderComposer() {
  const c = editing.campaign;
  const t = currentTemplate();
  const view = el('view-campaigns');
  const segs = audienceOptions(c.audience);
  const scheduled = c.status === 'scheduled';
  view.innerHTML = `
    <div class="page composer-page">
      <header class="page-head">
        <div class="grow">
          <span class="eyebrow"><a href="#/campaigns">Campaigns</a> / ${scheduled ? 'Scheduled' : 'Draft'}</span>
          <input class="title-input" data-name value="${escapeHtml(c.name)}" aria-label="Campaign name" maxlength="80" />
        </div>
        ${scheduled ? `<button type="button" class="btn" data-cancel>Stop this campaign</button>` : '<button type="button" class="link-btn" data-delete>Delete draft</button>'}
      </header>
      ${scheduled ? `<p class="notice">Scheduled for <b>${escapeHtml(dateTime(c.scheduledAt))}</b>. You can still change it until then.</p>` : ''}
      <div class="composer-grid">
        <div class="steps">
          <section class="step">
            <h2><span>1</span> Who gets it</h2>
            <div class="row-fields">
              <select data-segment aria-label="Group">${segs}</select>
              <input data-tag value="${escapeHtml(c.audience.tag || '')}" placeholder="Only with tag (optional)" aria-label="Only customers with this tag" list="tag-suggestions" maxlength="30" />
            </div>
            <p class="step-note" data-estimate>Counting…</p>
          </section>

          <section class="step">
            <h2><span>2</span> Message</h2>
            <div class="row-fields">
              <select data-template aria-label="Message template"><option value="">Choose a message…</option>${templateOptions()}</select>
              <button type="button" class="btn" data-new-template>${ico('plus')}Write a new one</button>
            </div>
            <div data-new-form class="new-template hidden"></div>
            ${t && t.headerFormat === 'IMAGE' ? `<label class="field"><span>Photo at the top (link, starting with https://)</span><input data-image value="${escapeHtml(c.headerImageUrl || '')}" placeholder="https://cdn.shopify.com/…jpg" /></label>` : ''}
            ${paramsHtml(t)}
            ${t && !t.canSend ? `<p class="warn">${escapeHtml(t.unsupported || `This message is ${t.statusLabel.toLowerCase()}. Campaigns can only use messages Meta has approved.`)}</p>` : ''}
          </section>

          <section class="step">
            <h2><span>3</span> When</h2>
            <div class="when">
              <label class="radio"><input type="radio" name="when" value="now" ${scheduled ? '' : 'checked'} /> Send now</label>
              <label class="radio"><input type="radio" name="when" value="later" ${scheduled ? 'checked' : ''} /> Later:
                <input type="datetime-local" data-when value="${localInputValue(c.scheduledAt)}" aria-label="Send at" /></label>
            </div>
            <p class="step-note" data-when-note></p>
          </section>

          <div class="summary-bar">
            <div class="bar-text"><b data-summary>…</b><span data-summary-sub></span></div>
            <button type="button" class="btn btn-ghost" data-test>Send a test to me</button>
            <button type="button" class="btn btn-saffron" data-go>${scheduled ? 'Update schedule' : 'Send now'}</button>
          </div>
        </div>

        <aside class="phone-preview" aria-label="How it looks on the customer's phone">
          <div class="phone-top"><span class="avatar" style="background:#F2B829">TK</span><b>Thakar Kitchen</b></div>
          <div class="phone-body" data-preview>${renderedPreview(t)}</div>
        </aside>
      </div>
    </div>`;
  wireComposer();
  updateWhenNote();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const c = editing.campaign;
    try {
      await patch(`/api/campaigns/${c._id}`, {
        name: c.name,
        audience: c.audience,
        templateId: c.templateId || null,
        bodyParams: c.bodyParams,
        headerImageUrl: c.headerImageUrl || '',
      });
    } catch (err) {
      toast(`Not saved: ${err.message}`);
    }
  }, 400);
}

async function refreshEstimate() {
  const c = editing.campaign;
  const params = new URLSearchParams({ segment: c.audience.segment, tag: c.audience.tag || '' });
  if (hasFilters(c.audience)) params.set('filters', JSON.stringify(c.audience.filters));
  if (c.templateId) params.set('templateId', c.templateId);
  try {
    const e = await api(`/api/campaigns/estimate?${params}`);
    if (!editing || editing.campaign._id !== c._id) return;
    editing.estimate = e;
    const view = el('view-campaigns');
    const est = view.querySelector('[data-estimate]');
    if (est) {
      est.innerHTML = `<b>${plural(e.inGroup, 'customer')}</b> in this group, <b>${e.optedIn.toLocaleString('en-IN')}</b> opted in to offers.` +
        (e.recentlyMessaged > 0 ? ` ${plural(e.recentlyMessaged, 'person', 'people')} got an offer in the last ${e.gapHours} hours and will be skipped.` : '') +
        (e.optedIn === 0 ? ' <a href="#/customers">Opt customers in on the Customers page.</a>' : '');
    }
    const sum = view.querySelector('[data-summary]');
    if (sum) {
      sum.textContent = `${plural(e.eligible, 'message')} · about ${money(e.cost.total)}`;
      view.querySelector('[data-summary-sub]').textContent = `${money(e.cost.each)} each incl. GST (Meta's ${e.category === 'MARKETING' ? 'marketing' : 'utility'} rate). No platform fee.`;
    }
  } catch (err) {
    /* estimate is informational */
  }
}

function updateWhenNote() {
  const view = el('view-campaigns');
  const later = view.querySelector('input[name="when"][value="later"]').checked;
  const note = view.querySelector('[data-when-note]');
  const go = view.querySelector('[data-go]');
  if (!later) {
    note.textContent = 'Starts right away and takes a few minutes for a big group.';
    go.textContent = 'Send now';
    return;
  }
  const at = new Date(view.querySelector('[data-when]').value);
  const h = at.getHours();
  note.textContent = Number.isNaN(at.getTime())
    ? 'Pick a date and time.'
    : h >= 21 || h < 9
    ? 'That is late at night for your customers. Between 10am and 8pm usually works best.'
    : `Goes out ${dateTime(at)}.`;
  go.textContent = editing.campaign.status === 'scheduled' ? 'Update schedule' : 'Schedule';
}

function wireComposer() {
  const view = el('view-campaigns');
  const c = editing.campaign;
  const q = (s) => view.querySelector(s);

  q('[data-name]').addEventListener('input', (e) => {
    c.name = e.target.value.trim() || 'Untitled campaign';
    scheduleSave();
  });
  q('[data-segment]').addEventListener('change', (e) => {
    const [kind, value] = e.target.value.split(':');
    if (kind === 'stage') Object.assign(c.audience, { segment: value, filters: {}, label: '' });
    if (kind === 'group') {
      const g = (groupsCache || []).find((x) => x._id === value);
      if (g) Object.assign(c.audience, { segment: g.segment, filters: { ...g.filters }, label: g.name });
    }
    scheduleSave();
    refreshEstimate();
  });
  q('[data-tag]').addEventListener('change', (e) => {
    c.audience.tag = e.target.value.trim();
    scheduleSave();
    refreshEstimate();
  });
  q('[data-template]').addEventListener('change', (e) => {
    c.templateId = e.target.value || null;
    const t = currentTemplate();
    c.bodyParams = t ? Array.from({ length: t.paramCount }, (_, i) => (i === 0 ? { source: 'first_name', text: '' } : { source: 'text', text: '' })) : [];
    scheduleSave();
    renderComposer();
    refreshEstimate();
  });
  for (const sel of view.querySelectorAll('[data-param-source]')) {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.paramSource);
      c.bodyParams[i] = { source: sel.value, text: (c.bodyParams[i] && c.bodyParams[i].text) || '' };
      view.querySelector(`[data-param-text="${i}"]`).hidden = sel.value === 'first_name';
      q('[data-preview]').innerHTML = renderedPreview(currentTemplate());
      scheduleSave();
    });
  }
  for (const input of view.querySelectorAll('[data-param-text]')) {
    input.addEventListener('input', () => {
      const i = Number(input.dataset.paramText);
      c.bodyParams[i] = { source: 'text', text: input.value };
      q('[data-preview]').innerHTML = renderedPreview(currentTemplate());
      scheduleSave();
    });
  }
  const image = q('[data-image]');
  if (image) {
    image.addEventListener('change', () => {
      c.headerImageUrl = image.value.trim();
      q('[data-preview]').innerHTML = renderedPreview(currentTemplate());
      scheduleSave();
    });
  }
  for (const r of view.querySelectorAll('input[name="when"]')) r.addEventListener('change', updateWhenNote);
  q('[data-when]').addEventListener('input', () => {
    view.querySelector('input[name="when"][value="later"]').checked = true;
    updateWhenNote();
  });
  q('[data-new-template]').addEventListener('click', () => showNewTemplateForm(q('[data-new-form]')));

  q('[data-test]').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await patch(`/api/campaigns/${c._id}`, { name: c.name, audience: c.audience, templateId: c.templateId, bodyParams: c.bodyParams, headerImageUrl: c.headerImageUrl || '' }).catch(() => {});
    try {
      const r = await post(`/api/campaigns/${c._id}/test`);
      toast(state.config.testMode ? 'Test message saved to your own chat (test mode: not sent).' : 'Test sent to your WhatsApp.');
      if (r.conversationId && confirm('Open the test message now?')) location.hash = `#/inbox/${r.conversationId}`;
    } catch (err) {
      toast(err.message);
    }
  });

  q('[data-go]').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    const now = view.querySelector('input[name="when"][value="now"]').checked;
    const e = editing.estimate;
    const count = e ? e.eligible : 0;
    const question = now
      ? `Send "${c.name}" now to ${plural(count, 'customer')}? It costs about ${money(e ? e.cost.total : 0)}.${state.config.testMode ? '\n\n(Test mode: nothing is actually sent.)' : ''}`
      : `Schedule "${c.name}" for ${dateTime(new Date(q('[data-when]').value))}?`;
    if (!confirm(question)) return;
    try {
      await patch(`/api/campaigns/${c._id}`, { name: c.name, audience: c.audience, templateId: c.templateId, bodyParams: c.bodyParams, headerImageUrl: c.headerImageUrl || '' });
      await post(`/api/campaigns/${c._id}/schedule`, now ? { now: true } : { sendAt: new Date(q('[data-when]').value).toISOString() });
      toast(now ? 'Sending started' : 'Scheduled');
      showOne(c._id);
    } catch (err) {
      toast(err.message);
    }
  });

  const cancel = q('[data-cancel]');
  if (cancel) {
    cancel.addEventListener('click', async () => {
      if (!confirm('Stop this campaign? It will not go out.')) return;
      try {
        await post(`/api/campaigns/${c._id}/cancel`);
        showOne(c._id);
      } catch (err) {
        toast(err.message);
      }
    });
  }
  const remove = q('[data-delete]');
  if (remove) {
    remove.addEventListener('click', async () => {
      if (!confirm('Delete this draft?')) return;
      try {
        await del(`/api/campaigns/${c._id}`);
        location.hash = '#/campaigns';
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

function showNewTemplateForm(box) {
  box.classList.remove('hidden');
  box.innerHTML = `
    <label class="field"><span>Name (just for you)</span><input data-t-label placeholder="e.g. Diwali offer" maxlength="60" /></label>
    <label class="field"><span>Message</span><textarea data-t-body rows="5" placeholder="Hi {{1}}, our Diwali sweets box is here! Order before Sunday for delivery before the festival."></textarea></label>
    <div class="row-fields"><button type="button" class="btn btn-small" data-t-insert>Insert customer's first name</button><span class="muted">It shows as {{1}}, {{2}}…</span></div>
    <div class="row-fields">
      <input data-t-btn placeholder="Button text (optional), e.g. Order now" maxlength="25" aria-label="Button text" />
      <input data-t-url placeholder="Button link, e.g. https://thakarkitchen.com" aria-label="Button link" />
    </div>
    <p class="card-note">A "Stop promotions" button is added so customers can opt out. ${state.config.testMode ? 'In test mode you can use it straight away.' : 'It goes to Meta for approval, usually within minutes to a day.'}</p>
    <div class="row-fields"><button type="button" class="btn btn-primary" data-t-save>Save message</button><button type="button" class="link-btn" data-t-cancel>Cancel</button></div>`;
  const q = (s) => box.querySelector(s);
  q('[data-t-insert]').addEventListener('click', () => {
    const ta = q('[data-t-body]');
    const count = (ta.value.match(/\{\{\d+\}\}/g) || []).length;
    const token = `{{${count + 1}}}`;
    const pos = ta.selectionStart || ta.value.length;
    ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos);
    ta.focus();
  });
  q('[data-t-cancel]').addEventListener('click', () => {
    box.classList.add('hidden');
    box.innerHTML = '';
  });
  q('[data-t-save]').addEventListener('click', async () => {
    try {
      const t = await post('/api/templates', {
        label: q('[data-t-label]').value,
        body: q('[data-t-body]').value,
        buttonText: q('[data-t-btn]').value,
        buttonUrl: q('[data-t-url]').value,
      });
      await loadTemplates(true);
      editing.campaign.templateId = t._id;
      editing.campaign.bodyParams = Array.from({ length: t.paramCount }, (_, i) => (i === 0 ? { source: 'first_name', text: '' } : { source: 'text', text: '' }));
      scheduleSave();
      toast(t.submitError ? `Saved, but Meta said: ${t.submitError}` : t.canSend ? 'Message saved' : 'Saved and sent to Meta for approval');
      renderComposer();
      refreshEstimate();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- Results ----------
function renderResults(res) {
  const c = res.campaign;
  const s = res.stats;
  const pct = (n) => (s.sent ? `${Math.round((n / s.sent) * 100)}%` : '—');
  el('view-campaigns').innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="grow">
          <span class="eyebrow"><a href="#/campaigns">Campaigns</a></span>
          <h1 class="page-title">${escapeHtml(c.name)}</h1>
          <p class="page-sub">${statusPill(c.status)} ${escapeHtml(audienceLabel(c.audience))}${c.startedAt ? ` · started ${escapeHtml(dateTime(c.startedAt))}` : ''}</p>
        </div>
        ${c.status === 'sending' ? '<button type="button" class="btn" data-cancel>Stop sending</button>' : ''}
      </header>
      ${c.lastError ? `<p class="warn">${escapeHtml(c.lastError)}</p>` : ''}
      ${state.config.testMode ? '<p class="notice">Test mode: these messages were saved in chats but not actually sent, so there are no ticks or replies.</p>' : ''}
      <section class="kpis six">
        <div class="kpi"><span class="kpi-label">Sent</span><span class="kpi-value">${s.sent}</span><span class="kpi-sub">of ${c.counts.audience} in the group</span></div>
        <div class="kpi"><span class="kpi-label">Delivered</span><span class="kpi-value">${pct(s.delivered)}</span><span class="kpi-sub">${s.delivered} people</span></div>
        <div class="kpi"><span class="kpi-label">Read</span><span class="kpi-value">${pct(s.read)}</span><span class="kpi-sub">${s.read} people</span></div>
        <div class="kpi"><span class="kpi-label">Replied</span><span class="kpi-value">${s.replied}</span><span class="kpi-sub">within 3 days</span></div>
        <div class="kpi"><span class="kpi-label">Orders</span><span class="kpi-value">${s.orders}</span><span class="kpi-sub">${money(s.revenue)} within 7 days</span></div>
        <div class="kpi"><span class="kpi-label">Not delivered</span><span class="kpi-value">${s.failed}</span><span class="kpi-sub">${s.failed ? 'see the reason in each chat' : 'none'}</span></div>
      </section>
      ${s.sent ? earnedHtml(s) : ''}
      ${res.template ? `<section class="card"><h2>The message</h2><div class="wa-preview">${renderedPreviewFor(res.template, c)}</div></section>` : ''}
    </div>`;
  const cancel = el('view-campaigns').querySelector('[data-cancel]');
  if (cancel) {
    cancel.addEventListener('click', async () => {
      if (!confirm('Stop sending? People who already got it keep it.')) return;
      try {
        await post(`/api/campaigns/${c._id}/cancel`);
        showOne(c._id);
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

// What the campaign cost and what came back: orders from people who got it,
// placed within 7 days.
function earnedHtml(s) {
  const times = s.cost > 0 ? s.revenue / s.cost : 0;
  const verdict = !s.orders
    ? 'No orders yet from people who got it. Orders placed within 7 days of the message count here.'
    : `It cost about ${money(s.cost)} and brought in ${money(s.revenue)}${times >= 1 ? ` — about ${Math.round(times)}× what you spent` : ''}.`;
  const rows = (s.orderList || [])
    .map((o) => `<a class="box-row" href="#/customers/${escapeHtml(o.phone || '')}"><span><b>${escapeHtml(o.name)}</b> · ${escapeHtml(o.customerName || '')}<div class="sub">${escapeHtml(shortDate(o.placedAt))}</div></span><span>${money(o.total)}</span></a>`)
    .join('');
  return `
    <section class="card earned">
      <h2>Money in vs. money out</h2>
      <p class="card-note">${escapeHtml(verdict)}</p>
      ${rows ? `<div class="box">${rows}</div>` : ''}
    </section>`;
}

function renderedPreviewFor(t, c) {
  const params = (c.bodyParams || []).map((p) => (p.source === 'first_name' ? 'Priya' : p.text));
  const text = t.body.replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] || m);
  const buttons = (t.urlButtons || []).map((b) => b.text).concat(t.quickReplies || []);
  return `<div class="wa-bubble">${escapeHtml(text)}</div>${buttons.length ? `<div class="wa-buttons">${buttons.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>` : ''}`;
}

export function showCampaigns(route) {
  editing = null;
  if (route.id === 'new') return createAndOpen(new URLSearchParams(route.query || ''));
  if (route.id && /^[a-f0-9]{24}$/.test(route.id)) return showOne(route.id);
  return showList();
}

// Keeps a sending campaign's numbers fresh.
export function refreshCampaigns(route) {
  if (route.id && /^[a-f0-9]{24}$/.test(route.id) && !editing && viewingStatus === 'sending') showOne(route.id);
}
