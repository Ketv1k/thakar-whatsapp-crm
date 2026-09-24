const test = require('node:test');
const assert = require('node:assert');
const consent = require('../src/services/consent');
const { consentFromShopify } = require('../src/services/customerSync');
const { isRetryable } = require('../src/services/whatsapp');
const { shouldRetry } = require('../src/services/outbound');
const { detectKeyword } = require('../src/services/optIn');

test('order updates go to everyone who orders, unless they replied STOP ALL', () => {
  assert.deepEqual(consent.orderUpdatesAllowed(null), { allowed: true, basis: 'gave their number when ordering' });
  assert.equal(consent.orderUpdatesAllowed({ optedInMarketing: false, optedOutAt: new Date() }).allowed, true);
  assert.deepEqual(consent.orderUpdatesAllowed({ noWhatsApp: true, optedInMarketing: true }), { allowed: false, reason: 'They asked for no WhatsApp messages (STOP ALL)' });
});

test('bulk opt-ins need a stated reason, saved as proof', () => {
  assert.throws(() => consent.bulkEvidence('', 'group opt-in', 'Ketvik'), /Say where/);
  assert.match(consent.bulkEvidence('Opted in on Zoko', 'group opt-in', 'Ketvik'), /^Opted in on Zoko — group opt-in by Ketvik on \d/);
  const f = consent.optInFields({ source: 'import', evidence: 'x', by: 'Priya' });
  assert.deepEqual([f.optedInMarketing, f.optInSource, f.optInEvidence, f.optInBy, f.optedOutAt, f.noWhatsApp], [true, 'import', 'x', 'Priya', null, false]);
});

test("Shopify's WhatsApp consent is used; SMS consent never is", () => {
  const at = '2026-09-20T10:00:00Z';
  const on = consentFromShopify({}, { state: 'SUBSCRIBED', updatedAt: at });
  assert.equal(on.optedInMarketing, true);
  assert.equal(on.optInSource, 'shopify_whatsapp');
  assert.match(on.optInEvidence, /WhatsApp marketing in Shopify/);
  // A STOP here after Shopify's consent wins.
  assert.deepEqual(consentFromShopify({ optedOutAt: '2026-09-21T10:00:00Z' }, { state: 'SUBSCRIBED', updatedAt: at }), {});
  // Unsubscribed in Shopify after opting in here: opted out.
  assert.equal(consentFromShopify({ optedInMarketing: true, optedInAt: '2026-09-01T00:00:00Z' }, { state: 'UNSUBSCRIBED', updatedAt: at }).optedInMarketing, false);
  assert.deepEqual(consentFromShopify({}, { state: 'NEVER_SUBSCRIBED' }), {});
  assert.deepEqual(consentFromShopify({}, null), {});
});

test('only temporary WhatsApp problems are retried, at most 3 tries', () => {
  const meta = (status, code) => ({ response: { status, data: { error: { code } } } });
  assert.equal(isRetryable(new Error('socket hang up')), true); // no answer from Meta
  assert.equal(isRetryable(meta(500, 1)), true);
  assert.equal(isRetryable(meta(429, 130429)), true);
  assert.equal(isRetryable(meta(400, 131016)), true);
  assert.equal(isRetryable(meta(400, 131026)), false); // not on WhatsApp
  assert.equal(isRetryable(meta(400, 132001)), false); // template problem
  assert.equal(shouldRetry({ ok: false, retryable: true }, 0), true);
  assert.equal(shouldRetry({ ok: false, retryable: true }, 2), false);
  assert.equal(shouldRetry({ ok: false, retryable: false }, 0), false);
  assert.equal(shouldRetry({ ok: true }, 0), false);
});

test('STOP ALL stops every message; STOP only offers', () => {
  assert.equal(detectKeyword('STOP ALL'), 'stop_all');
  assert.equal(detectKeyword('Stop all messages'), 'stop_all');
  assert.equal(detectKeyword('stop'), 'stop');
  assert.equal(detectKeyword('start'), 'start');
});
