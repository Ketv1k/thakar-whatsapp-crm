// Notifications on this device: turn on/off, and send a test one.
import { api, post, toast } from './core.js';

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIphoneBrowserTab() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return ios && !installed;
}

function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export function notificationsHtml() {
  return `
    <h2>Notifications on this device</h2>
    <p class="card-note">Get a pop-up for new customer messages, new tickets, COD cancel requests, reminders that are due, birthdays and tickets waiting too long.</p>
    <div class="notify-row" data-notify-row><span class="muted">Checking…</span></div>`;
}

export async function wireNotifications(card) {
  const row = card.querySelector('[data-notify-row]');
  const render = async () => {
    if (isIphoneBrowserTab()) {
      row.innerHTML = '<p class="notice">On iPhone, first add the app to your home screen: tap Share, then "Add to Home Screen". Open it from there and turn notifications on.</p>';
      return;
    }
    if (!supported()) {
      row.innerHTML = '<p class="notice">This browser can\'t show notifications. Try Chrome on Android or a computer, or the app added to an iPhone home screen.</p>';
      return;
    }
    if (Notification.permission === 'denied') {
      row.innerHTML = '<p class="notice">Notifications are blocked for this site. Allow them in the browser\'s site settings, then come back here.</p>';
      return;
    }
    const sub = await currentSubscription().catch(() => null);
    row.innerHTML = sub
      ? `<span class="pill pill-green">On for this device</span>
         <button type="button" class="btn btn-small" data-test-push>Send me a test</button>
         <button type="button" class="link-btn" data-push-off>Turn off</button>`
      : '<button type="button" class="btn btn-small btn-primary" data-push-on>Turn on notifications</button>';
    const on = row.querySelector('[data-push-on]');
    if (on) on.addEventListener('click', turnOn);
    const off = row.querySelector('[data-push-off]');
    if (off) off.addEventListener('click', turnOff);
    const test = row.querySelector('[data-test-push]');
    if (test) test.addEventListener('click', sendTest);
  };

  async function turnOn() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return render();
      const { publicKey } = await api('/api/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await post('/api/push/subscribe', { subscription: sub.toJSON() });
      toast('Notifications are on for this device');
      render();
    } catch (err) {
      toast(`Couldn't turn on: ${err.message}`);
    }
  }

  async function turnOff() {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  async function sendTest() {
    try {
      const r = await post('/api/push/test');
      toast(r.sent ? 'Sent. It should pop up in a few seconds.' : "Couldn't reach this device. Turn notifications off and on again.");
    } catch (err) {
      toast(err.message);
    }
  }

  render();
}
