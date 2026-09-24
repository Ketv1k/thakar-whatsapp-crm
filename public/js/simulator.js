// Test page (test mode only): pretend to be a customer, and try every
// automation with pretend orders, carts and restocks. Nothing is sent.
import { state, api, post, patch, el, escapeHtml, ISSUE_LABELS, isCurrent, isOwner } from './core.js';

const TEST_SAMPLES = [
  ['Order status', 'Hi, where is my order?'],
  ['Damaged', 'My order arrived but one container was broken and leaking'],
  ['Missing item', 'One item is missing from my box'],
  ['Wrong item', 'You sent me the wrong item'],
  ['Refund', 'I want a refund for my last order'],
  ['Late delivery', "It's been 5 days and my order is still not delivered yet"],
  ['Bad taste', 'The dal tasted bad and was not fresh'],
  ['Payment', "Money deducted but I didn't get any order confirmation"],
  ['Hi', 'Hi'],
  ['Question', 'Do you have Jain options without onion and garlic?'],
  ['Bulk order', 'I want to place a bulk order for a family function'],
  ['Delivery area', 'Do you deliver to Pune?'],
  ['Compliment', 'Loved the food, thank you!'],
  ['Ok thanks', 'ok thanks'],
  ['Free delivery?', 'Free delivery kitna order pe milta hai?'],
  ['How to heat', 'How do I heat it? Can I use a microwave?'],
  ['STOP', 'STOP'],
  ['START', 'START'],
];
let testCustomers = null;

function who() {
  const choice = el('test-customer').value;
  const c = choice === 'custom' ? null : testCustomers[Number(choice)];
  return { phone: c ? c.phone : el('test-phone').value, name: c ? c.name : el('test-name').value };
}

function repliesHtml(replies) {
  if (replies === null) return ''; // a test of your own alerts: nothing goes to a customer
  if (!replies || !replies.length) return '<div class="would">No message to the customer</div>';
  return (
    '<div class="would">The customer would receive</div>' +
    replies
      .map((r) => {
        const body = typeof r === 'string' ? r : r.body;
        const buttons = (r && r.buttons) || [];
        const failed = r && r.failed ? `<div class="warn">Not sent: ${escapeHtml(r.failed)}</div>` : '';
        return `<div class="reply">${escapeHtml(body)}${buttons.length ? `<div class="wa-buttons">${buttons.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>` : ''}${failed}</div>`;
      })
      .join('')
  );
}

function showResult(outcome, r, extra = '') {
  el('test-result').innerHTML = `
    <div class="result">
      <div class="outcome">${outcome}</div>
      ${repliesHtml(r.replies)}
      ${extra}
      ${r.conversationId ? `<a class="btn btn-dark" style="align-self:flex-start" href="#/inbox/${r.conversationId}">Open the chat</a>` : ''}
    </div>`;
  el('test-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showError(err) {
  el('test-result').innerHTML = `<div class="result error">${escapeHtml(err.message)}</div>`;
}

const OFF_NOTE = (what) => `Nothing was sent: switch on <b>${what}</b> in <a href="#/automations">Automations</a> first.`;

function decisionText(d, sentText) {
  if (d.action === 'sent') return sentText;
  if (d.action === 'failed') return `WhatsApp refused it: ${escapeHtml(d.reason)}`;
  if (d.reason === 'Automation is off') return null;
  return `Nothing was sent: ${escapeHtml(d.reason)}.`;
}

async function busy(fn) {
  const buttons = el('view-test').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  el('test-result').innerHTML = '<div class="result">Working…</div>';
  try {
    await fn();
  } catch (err) {
    showError(err);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function sendMessage(type) {
  const w = who();
  await busy(async () => {
    const r = await post('/api/test/simulate', { type, phone: w.phone, name: w.name, text: type === 'audio' ? '' : el('test-text').value });
    const issue = ISSUE_LABELS[r.issueType] || r.issueType;
    const outcome = {
      auto_answered: 'Answered automatically from Shopify. No work for you.',
      ticket_created: `Ticket #${r.ticketNumber} opened (${issue}). It's waiting in your Inbox.`,
      added_to_ticket: `Added to their open ticket #${r.ticketNumber}.`,
      ai_answered: 'Answered automatically by AI from your website info. No work for you.',
      acknowledged: 'Acknowledged automatically. It is waiting in your Inbox for you to reply.',
      chat: 'Added to your Inbox for you to reply.',
    }[r.outcome];
    showResult(escapeHtml(outcome), r);
    if (type !== 'audio') el('test-text').value = '';
  });
}

async function renderOrders() {
  const box = el('test-orders');
  if (!box) return;
  let orders = [];
  try {
    orders = await api('/api/test/orders');
  } catch (err) {
    /* optional */
  }
  if (!el('test-orders')) return;
  box.innerHTML = orders.length
    ? orders
        .map((o) => {
          const steps = [];
          if (o.cod && o.cod.status === 'awaiting') {
            steps.push(`<button type="button" class="btn btn-small btn-ok" data-tap="${o._id}:confirm">Customer taps "Confirm order"</button>`);
            steps.push(`<button type="button" class="btn btn-small" data-tap="${o._id}:cancel">Customer taps "Cancel order"</button>`);
          }
          if (!o.shippedAt) steps.push(`<button type="button" class="btn btn-small" data-step="${o._id}:shipped">Ship it</button>`);
          if (o.shippedAt && !o.outForDeliveryAt && !o.deliveredAt) steps.push(`<button type="button" class="btn btn-small" data-step="${o._id}:out_for_delivery">Out for delivery</button>`);
          if (!o.deliveredAt) steps.push(`<button type="button" class="btn btn-small" data-step="${o._id}:delivered">Delivered</button>`);
          const cod = o.isCod ? ` · COD ${o.cod.status === 'none' ? '' : o.cod.status.replace('_', ' ')}` : ' · prepaid';
          return `<div class="order-row"><div class="order-main"><b>${escapeHtml(o.name)}</b><small>${escapeHtml(o.customerName || o.phone)}${escapeHtml(cod)}</small></div><div class="order-actions">${steps.join('')}</div></div>`;
        })
        .join('')
    : '<p class="card-note">No test orders yet.</p>';
  for (const b of box.querySelectorAll('[data-step]')) {
    b.addEventListener('click', () => {
      const [id, step] = b.dataset.step.split(':');
      busy(async () => {
        const r = await post(`/api/test/order/${id}/advance`, { step });
        const text = r.off
          ? OFF_NOTE('Order updates')
          : Object.values(r.results).includes('sent')
          ? 'The customer got an order update.'
          : 'Nothing new to send for this step.';
        showResult(text, r);
        renderOrders();
      });
    });
  }
  for (const b of box.querySelectorAll('[data-tap]')) {
    b.addEventListener('click', () => {
      const [id, choice] = b.dataset.tap.split(':');
      busy(async () => {
        const r = await post(`/api/test/order/${id}/tap`, { choice });
        showResult(
          r.cod.status === 'confirmed'
            ? 'Order confirmed by the customer, and tagged "COD confirmed on WhatsApp" (in Shopify once live).'
            : 'The customer wants to cancel. It shows on Home and in COD orders so you can cancel it in Shopify.',
          r
        );
        renderOrders();
      });
    });
  }
}

async function placeOrder() {
  const w = who();
  await busy(async () => {
    const r = await post('/api/test/order', { ...w, cod: el('test-cod').checked, total: el('test-total').value, agreed: el('test-agreed').checked });
    const sent = Object.entries(r.results).filter(([, v]) => v === 'sent').map(([k]) => k);
    const text = r.off
      ? OFF_NOTE(el('test-cod').checked ? 'COD confirmation or Order updates' : 'Order updates')
      : !el('test-agreed').checked && !sent.length
      ? `Test order ${escapeHtml(r.order.name)} placed. No message: this customer hasn't agreed to WhatsApp order updates, so none is sent (unless you confirm your checkout wording in Automations).`
      : sent.includes('cod_request')
      ? `Test order ${escapeHtml(r.order.name)} placed as COD. The customer was asked to confirm it. Try their answer below.`
      : `Test order ${escapeHtml(r.order.name)} placed. The customer got the order confirmation.`;
    showResult(text, r);
    renderOrders();
  });
}

// Reminder tests use a new made-up customer each time: real customers
// aren't changed, and the "already reminded" limits never get in the way.
function freshCustomer() {
  const n = String(Math.floor(10000 + Math.random() * 90000));
  return { phone: `9190000${n}`, name: `Test customer ${n.slice(-4)}` };
}

const AUTOMATION_KEYS = { cart: 'abandoned_cart', reorder: 'reorder_reminder', restock: 'back_in_stock' };
const AUTOMATION_LABELS = { cart: 'Abandoned cart', reorder: 'Reorder reminders', restock: 'Back-in-stock alerts' };

async function marketing(kind) {
  const w = freshCustomer();
  const optIn = el('test-optin').checked;
  await busy(async () => {
    const r = await post(`/api/test/${kind}`, { ...w, optIn, product: el('test-product').value });
    const sentText = {
      cart: `Cart reminder sent to ${escapeHtml(w.name)}, with the link that reopens their order in Magic Checkout.`,
      reorder: `Reorder reminder sent to ${escapeHtml(w.name)} for their order from 3 weeks ago.`,
      restock: `Back-in-stock message sent to ${escapeHtml(w.name)}.`,
    }[kind];
    if (r.decision && r.decision.reason === 'Automation is off') {
      showResult(
        `Nothing was sent: <b>${AUTOMATION_LABELS[kind]}</b> is switched off.`,
        r,
        isOwner() ? `<button type="button" class="btn btn-primary" style="align-self:flex-start" data-turn-on="${kind}">Turn it on and try again</button>` : '<p class="card-note">Ask the owner to switch it on in Automations.</p>'
      );
      const on = el('test-result').querySelector('[data-turn-on]');
      if (on) {
        on.addEventListener('click', async () => {
          await patch(`/api/automations/${AUTOMATION_KEYS[kind]}`, { enabled: true });
          marketing(kind);
        });
      }
      return;
    }
    const why = r.decision && r.decision.action === 'skip' && r.decision.reason === 'Not opted in to offers'
      ? 'Nothing was sent: this customer hasn\'t agreed to get messages. Tick the box above to try it as someone who has.'
      : null;
    showResult(why || decisionText(r.decision, sentText) || OFF_NOTE(AUTOMATION_LABELS[kind]), r);
  });
}

// Your own reminders and alerts (they also pop up as notifications).
async function alertTest(kind) {
  const w = freshCustomer();
  await busy(async () => {
    if (kind === 'push') {
      try {
        const r = await post('/api/push/test');
        showResult(`Test notification sent to ${r.sent} of your device${r.devices === 1 ? '' : 's'}. It should pop up in a few seconds.`, { replies: null });
      } catch (err) {
        showResult(`${escapeHtml(err.message)}. <a href="#/team">Turn notifications on</a> on this device, then try again.`, { replies: null });
      }
      return;
    }
    if (kind === 'follow-up') {
      const r = await post('/api/test/follow-up', w);
      showResult(
        `A reminder for <b>${escapeHtml(w.name)}</b> is due now. It's on <a href="#/home">Home</a> under "Needs your attention", and it pops up on devices that have notifications on. Tap Done on their profile to clear it.`,
        { replies: null },
        `<a class="btn btn-dark" style="align-self:flex-start" href="#/customers/${w.phone}">Open their profile</a>`
      );
      return;
    }
    if (kind === 'birthday') {
      const r = await post('/api/test/birthday', w);
      showResult(
        `<b>${escapeHtml(w.name)}</b> has a birthday today. It's on <a href="#/home">Home</a>, and it pops up on devices that have notifications on.`,
        { replies: null },
        `<a class="btn btn-dark" style="align-self:flex-start" href="#/customers/${w.phone}">Open their profile</a>`
      );
      return;
    }
    if (kind === 'overdue') {
      const r = await post('/api/test/overdue-ticket', w);
      showResult(
        `Ticket #${r.ticketNumber} from <b>${escapeHtml(w.name)}</b> has now waited over ${r.hours} hours. It shows as <b>Overdue</b> on <a href="#/home">Home</a> and in the inbox, and it pops up on devices that have notifications on (plus a WhatsApp alert to your own number once WhatsApp is connected).`,
        { replies: null, conversationId: r.conversationId }
      );
    }
  });
}

export async function showTest() {
  const view = el('view-test');
  if (view.querySelector('#test-send')) return;
  const aiOn = state.config.ai && state.config.ai.enabled;
  view.innerHTML = `
    <div class="test">
      <header class="home-head">
        <h1 class="page-title">Test</h1>
        <p>Pretend to be a customer and see exactly what your inbox and automations do. Nothing is sent to anyone.</p>
      </header>
      <div class="field">
        <label for="test-customer">Customer</label>
        <select id="test-customer"><option>Loading your Shopify customers…</option></select>
      </div>
      <div id="test-custom" class="field hidden">
        <input id="test-phone" inputmode="numeric" placeholder="Phone with country code, e.g. 919876543210" aria-label="Phone number" />
        <input id="test-name" placeholder="Their name (optional)" aria-label="Name" />
      </div>

      <section class="card test-card">
        <h2>They send a message</h2>
        <p class="card-note">${aiOn ? `AI answers are <b>on</b> (${escapeHtml(state.config.ai.model || state.config.ai.provider)}).` : 'AI answers are <b>off</b>: add your AI key in Render (AI_API_KEY) to turn them on.'}</p>
        <div class="test-chips" id="test-chips"></div>
        <textarea id="test-text" rows="3" placeholder="Type what the customer says, or tap an example. For a photo, this becomes its caption." aria-label="Their message"></textarea>
        <div class="test-actions">
          <button type="button" class="btn btn-primary" id="test-send">Send as customer</button>
          <button type="button" class="btn" id="test-photo">Send a photo</button>
          <button type="button" class="btn" id="test-voice">Send a voice note</button>
        </div>
      </section>

      <section class="card test-card">
        <h2>They place an order</h2>
        <div class="row-fields">
          <label class="inline">Total ₹ <input id="test-total" type="number" min="1" value="640" /></label>
          <label class="inline"><input id="test-cod" type="checkbox" /> Cash on delivery (₹99 paid online)</label>
          <label class="inline"><input id="test-agreed" type="checkbox" checked /> They agreed to WhatsApp order updates</label>
        </div>
        <div class="test-actions"><button type="button" class="btn btn-primary" id="test-order">Place test order</button></div>
        <div id="test-orders"></div>
      </section>

      <section class="card test-card">
        <h2>Reminders to customers</h2>
        <p class="card-note">Each try uses a new made-up customer, so you can repeat them as often as you like and real customers aren't changed.</p>
        <label class="inline"><input id="test-optin" type="checkbox" checked /> The customer said yes to WhatsApp messages (at checkout, or opted in to offers)</label>
        <div class="test-actions">
          <button type="button" class="btn" id="test-cart">They leave a cart</button>
          <button type="button" class="btn" id="test-reorder">Their order shipped 3 weeks ago</button>
        </div>
        <div class="row-fields">
          <input id="test-product" value="Methi Papad" aria-label="Product" />
          <button type="button" class="btn" id="test-restock">It's back in stock</button>
        </div>
      </section>

      <section class="card test-card">
        <h2>Your reminders and alerts</h2>
        <p class="card-note">What you and your team get. Turn on notifications on this device first (<a href="#/team">Team &amp; account</a>) to see them pop up.</p>
        <div class="test-actions">
          <button type="button" class="btn" data-alert="follow-up">A "Remind me" is due now</button>
          <button type="button" class="btn" data-alert="birthday">A customer's birthday is today</button>
          <button type="button" class="btn" data-alert="overdue">A ticket has waited too long</button>
          <button type="button" class="btn" data-alert="push">Send me a test notification</button>
        </div>
      </section>

      <div id="test-result" aria-live="polite"></div>
    </div>`;

  for (const [label, text] of TEST_SAMPLES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = label;
    chip.addEventListener('click', () => (el('test-text').value = text));
    el('test-chips').appendChild(chip);
  }
  el('test-send').addEventListener('click', () => sendMessage('text'));
  el('test-photo').addEventListener('click', () => sendMessage('image'));
  el('test-voice').addEventListener('click', () => sendMessage('audio'));
  el('test-order').addEventListener('click', placeOrder);
  el('test-cart').addEventListener('click', () => marketing('cart'));
  el('test-reorder').addEventListener('click', () => marketing('reorder'));
  el('test-restock').addEventListener('click', () => marketing('restock'));
  for (const b of view.querySelectorAll('[data-alert]')) b.addEventListener('click', () => alertTest(b.dataset.alert));
  renderOrders();

  if (!testCustomers) {
    try {
      testCustomers = await api('/api/test/customers');
    } catch (err) {
      testCustomers = [];
    }
  }
  if (!isCurrent('test')) return;
  const select = el('test-customer');
  select.innerHTML =
    testCustomers
      .map((c, i) => `<option value="${i}">${escapeHtml(c.name || 'Customer')} · …${escapeHtml(c.phone.slice(-4))} · ${c.ordersCount} order${c.ordersCount === 1 ? '' : 's'}</option>`)
      .join('') + '<option value="custom">Someone else (type a number)</option>';
  const sync = () => el('test-custom').classList.toggle('hidden', select.value !== 'custom');
  select.addEventListener('change', sync);
  sync();
}
