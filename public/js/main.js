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
//   #/team                         your account, notifications, and the team
//   #/more                         phone menu for the pages above
import { state, api, post, el, saveKey, fillIcons, initials, setUnauthorizedHandler, isOwner } from './core.js';
import { loadHome } from './home.js';
import { initInbox, showInbox, refreshInbox } from './inbox.js';
import { showCustomers, refreshCustomers } from './customers.js';
import { showAutomations } from './automations.js';
import { showCampaigns, refreshCampaigns } from './campaigns.js';
import { showOrders } from './orders.js';
import { showTest } from './simulator.js';
import { showMore } from './more.js';
import { showTeam } from './team.js';

const POLL_MS = 12000;
const VIEWS = ['home', 'inbox', 'customers', 'automations', 'campaigns', 'orders', 'test', 'team', 'more'];
// Which bottom-bar tab lights up on a phone for each screen.
const TAB_FOR = { automations: 'more', orders: 'more', test: 'more', team: 'more', more: 'more' };
// Screens only the owner sees.
const OWNER_VIEWS = ['automations', 'campaigns'];

// ---------- Login ----------
let useCode = false;

function showLogin() {
  el('login-screen').classList.remove('hidden');
  el('shell').classList.add('hidden');
  (useCode ? el('login-input') : el('login-email')).focus();
}

function setLoginMode(code) {
  useCode = code;
  el('login-email-fields').classList.toggle('hidden', code);
  el('login-code-fields').classList.toggle('hidden', !code);
  el('login-note').textContent = code
    ? 'Enter the access code. You\'ll only need to do this once on this device.'
    : 'Log in with your email and password. You\'ll only need to do this once on this device.';
  el('login-switch').textContent = code ? 'Log in with email and password instead' : 'Owner? Use the access code instead';
  el('login-error').classList.add('hidden');
  (code ? el('login-input') : el('login-email')).focus();
}

function logout() {
  saveKey('');
  showLogin();
}
setUnauthorizedHandler(logout);

function loginError(text) {
  el('login-error').textContent = text;
  el('login-error').classList.remove('hidden');
}

async function doLogin() {
  el('login-error').classList.add('hidden');
  el('login-button').disabled = true;
  try {
    if (useCode) {
      const value = el('login-input').value.trim();
      if (!value) return;
      state.apiKey = value;
      try {
        await api('/api/config');
      } catch (err) {
        return loginError('That access code was rejected. Check it and try again.');
      }
      saveKey(value);
    } else {
      const email = el('login-email').value.trim();
      const password = el('login-password').value;
      if (!email || !password) return loginError('Type your email and password.');
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return loginError(data.error || 'Could not log in. Try again.');
      saveKey(data.token);
      el('login-password').value = '';
    }
    start();
  } finally {
    el('login-button').disabled = false;
  }
}

// Logs out this device (and ends the session on the server).
export async function logoutHere() {
  try {
    await post('/api/logout');
  } catch (err) {
    /* logging out anyway */
  }
  logout();
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
  const me = state.config.user || { name: state.config.founderName, role: 'owner' };
  const myName = me.name || state.config.founderName || 'You';
  el('me-name').textContent = myName;
  el('me-avatar').textContent = initials(myName);
  el('me-role').textContent = me.role === 'owner' ? 'Owner' : 'Team';
  for (const view of OWNER_VIEWS) {
    for (const a of document.querySelectorAll(`[data-nav="${view}"]`)) a.classList.toggle('hidden', !isOwner());
  }
  document.body.dataset.role = me.role || 'owner';
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/home');
  else onRoute();
}

// ---------- Routing ----------
function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  let view = VIEWS.includes(parts[0]) ? parts[0] : 'home';
  if (view === 'test' && !state.config.testMode) view = 'home';
  if (OWNER_VIEWS.includes(view) && !isOwner()) view = 'home';
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
    case 'team':
      return showTeam();
    default:
      return null;
  }
}

// ---------- Boot ----------
el('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  doLogin();
});
el('login-switch').addEventListener('click', () => setLoginMode(!useCode));
el('logout-button').addEventListener('click', () => {
  if (confirm('Log out on this device? You will need to log in again.')) logoutHere();
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
