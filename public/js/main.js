// Thakar Kitchen inbox: login, navigation between screens, and keeping the
// open screen fresh.
//
// Screens (hash routes):
//   #/home                         today at a glance
//   #/inbox[/<chat>[/customer]]    every customer's chat
//   #/customers[/<phone>]          customer groups and profiles
//   #/automations                  automatic messages and their switches
//   #/campaigns[/new|/<id>]        broadcasts to a group
//   #/orders[/<status>]            COD answers
//   #/test                         pretend to be a customer (test mode only)
//   #/more                         phone menu for the pages above
import { state, api, el, saveKey, fillIcons, initials, setUnauthorizedHandler } from './core.js';
import { loadHome } from './home.js';
import { initInbox, showInbox, refreshInbox } from './inbox.js';
import { showCustomers, refreshCustomers } from './customers.js';
import { showAutomations } from './automations.js';
import { showCampaigns, refreshCampaigns } from './campaigns.js';
import { showOrders } from './orders.js';
import { showTest } from './simulator.js';
import { showMore } from './more.js';

const POLL_MS = 12000;
const VIEWS = ['home', 'inbox', 'customers', 'automations', 'campaigns', 'orders', 'test', 'more'];
// Which bottom-bar tab lights up on a phone for each screen.
const TAB_FOR = { automations: 'more', orders: 'more', test: 'more', more: 'more' };

// ---------- Login ----------
function showLogin() {
  el('login-screen').classList.remove('hidden');
  el('shell').classList.add('hidden');
  el('login-input').focus();
}

function logout() {
  saveKey('');
  showLogin();
}
setUnauthorizedHandler(logout);

async function doLogin() {
  const value = el('login-input').value.trim();
  if (!value) return;
  state.apiKey = value;
  el('login-error').classList.add('hidden');
  try {
    await api('/api/config');
    saveKey(value);
    start();
  } catch (err) {
    el('login-error').classList.remove('hidden');
  }
}

async function start() {
  el('login-screen').classList.add('hidden');
  el('shell').classList.remove('hidden');
  try {
    state.config = { ...state.config, ...(await api('/api/config')) };
  } catch (err) {
    /* keep defaults */
  }
  for (const node of document.querySelectorAll('.test-only')) node.classList.toggle('hidden', !state.config.testMode);
  if (state.config.founderName) {
    el('me-name').textContent = state.config.founderName;
    el('me-avatar').textContent = initials(state.config.founderName);
  }
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/home');
  else onRoute();
}

// ---------- Routing ----------
function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  let view = VIEWS.includes(parts[0]) ? parts[0] : 'home';
  if (view === 'test' && !state.config.testMode) view = 'home';
  const id = parts[1] || null;
  let pane = 'list';
  if (view === 'inbox' && id) pane = parts[2] === 'customer' ? 'customer' : 'thread';
  if (view === 'customers' && id) pane = 'detail';
  return { view, id, sub: parts[2] || null, pane, query };
}

function onRoute() {
  const prev = state.route;
  const route = parseRoute();
  state.route = route;
  document.body.dataset.view = route.view;
  document.body.dataset.pane = route.pane;
  for (const v of VIEWS) el(`view-${v}`).classList.toggle('hidden', v !== route.view);
  for (const a of document.querySelectorAll('.side-nav [data-nav]')) {
    if (a.dataset.nav === route.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const tab = TAB_FOR[route.view] || route.view;
  for (const a of document.querySelectorAll('.tabbar [data-nav]')) {
    if (a.dataset.nav === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (route.view !== prev.view) window.scrollTo(0, 0);

  switch (route.view) {
    case 'home':
      return loadHome();
    case 'inbox':
      return showInbox(route, prev);
    case 'customers':
      return showCustomers(route, prev);
    case 'automations':
      return showAutomations();
    case 'campaigns':
      return showCampaigns(route);
    case 'orders':
      return showOrders(route);
    case 'test':
      return showTest();
    case 'more':
      return showMore();
    default:
      return null;
  }
}

// ---------- Boot ----------
el('login-button').addEventListener('click', doLogin);
el('login-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
el('logout-button').addEventListener('click', () => {
  if (confirm('Log out on this device? You will need the access code again.')) logout();
});
window.addEventListener('hashchange', onRoute);
fillIcons();
initInbox();

// Keep the open screen fresh (skipped while the tab is hidden).
setInterval(() => {
  if (!state.apiKey || document.hidden || el('shell').classList.contains('hidden')) return;
  const r = state.route;
  if (r.view === 'home') loadHome();
  if (r.view === 'inbox') refreshInbox();
  if (r.view === 'campaigns') refreshCampaigns(r);
}, POLL_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.apiKey && state.route.view === 'inbox') refreshInbox();
  if (!document.hidden && state.apiKey && state.route.view === 'customers') refreshCustomers();
});

if (state.apiKey) start();
else showLogin();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}
