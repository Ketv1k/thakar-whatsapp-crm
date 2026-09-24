const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyWhatsAppSignature } = require('../src/middleware/verifyWhatsAppSignature');

const SECRET = 'test-app-secret';

function makeReq(rawBody, signature) {
  const headers = signature ? { 'x-hub-signature-256': signature } : {};
  return {
    method: 'POST',
    rawBody: rawBody === null ? null : Buffer.from(rawBody),
    get(name) {
      return headers[name.toLowerCase()];
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

afterEach(() => {
  delete process.env.WHATSAPP_APP_SECRET;
});

test('accepts a request with a valid signature', () => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  const body = '{"hello":"world"}';
  const req = makeReq(body, sign(body));
  const res = makeRes();
  let called = false;
  verifyWhatsAppSignature(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('rejects a request with a wrong signature', () => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  const req = makeReq('{"hello":"world"}', 'sha256=deadbeef');
  const res = makeRes();
  let called = false;
  verifyWhatsAppSignature(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('rejects a tampered body under an otherwise valid-looking signature', () => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  const sig = sign('{"hello":"world"}');
  const req = makeReq('{"hello":"tampered"}', sig);
  const res = makeRes();
  let called = false;
  verifyWhatsAppSignature(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('rejects when secret is set but raw body is missing', () => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  const req = makeReq(null, sign('x'));
  const res = makeRes();
  verifyWhatsAppSignature(req, res, () => {});
  assert.equal(res.statusCode, 403);
});

test('skips verification for the GET handshake (no body to sign)', () => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  const req = { method: 'GET', get: () => undefined };
  const res = makeRes();
  let called = false;
  verifyWhatsAppSignature(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('refuses every message when no secret is configured', () => {
  const req = makeReq('{"hello":"world"}', undefined);
  const res = makeRes();
  let called = false;
  verifyWhatsAppSignature(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
});
