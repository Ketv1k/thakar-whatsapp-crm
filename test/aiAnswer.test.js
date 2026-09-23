const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ai = require('../src/services/aiAnswer');

// A tiny stand-in for the provider's API: records each request and replies
// with whatever the current test queued.
let server;
let baseUrl;
let requests = [];
let nextResponse = { status: 200, body: {} };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

afterEach(() => {
  requests = [];
  for (const k of ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL']) delete process.env[k];
});

function claudeReply(text, stopReason = 'end_turn') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test('AI is off until a key (and, for OpenAI-style providers, an address) is set', () => {
  assert.equal(ai.isConfigured(), false);
  process.env.AI_API_KEY = 'k';
  assert.equal(ai.isConfigured(), true); // Claude, default model
  assert.equal(ai.status().model, 'claude-opus-5');
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_MODEL = 'some-model';
  assert.equal(ai.isConfigured(), false); // needs AI_BASE_URL
  process.env.AI_BASE_URL = 'https://example.com/v1';
  assert.equal(ai.isConfigured(), true);
  process.env.AI_PROVIDER = 'unknown';
  assert.equal(ai.isConfigured(), false);
  assert.equal(JSON.stringify(ai.status()).includes('"k"'), false, 'status never exposes the key');
});

test('Claude: sends the shop knowledge cached, asks for structured JSON, uses the reply', async () => {
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_BASE_URL = baseUrl;
  nextResponse = { status: 200, body: claudeReply('{"answered": true, "reply": "Free delivery above ₹699."}') };

  const result = await ai.answer('free delivery?', [{ direction: 'inbound', body: 'hi' }]);
  assert.deepEqual(result, { answered: true, reply: 'Free delivery above ₹699.' });

  const req = requests[0];
  assert.match(req.url, /^\/v1\/messages/);
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.model, 'claude-opus-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
  assert.match(req.body.system[0].text, /<knowledge>[\s\S]*Free delivery on orders above Rs 699/);
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.output_config.effort, 'low');
  assert.match(req.body.messages[0].content, /Customer: hi[\s\S]*New message from the customer:\nfree delivery\?/);
});

test('Claude Haiku: no effort setting or server fallback (not supported there)', async () => {
  process.env.AI_API_KEY = 'k';
  process.env.AI_BASE_URL = baseUrl;
  process.env.AI_MODEL = 'claude-haiku-4-5';
  nextResponse = { status: 200, body: claudeReply('{"answered": false, "reply": ""}') };
  const result = await ai.answer('do you make salt-free food?');
  assert.deepEqual(result, { answered: false, reply: '' });
  assert.equal(requests[0].body.output_config.effort, undefined);
  assert.equal(requests[0].body.fallbacks, undefined);
  assert.equal(requests[0].headers['anthropic-beta'], undefined);
});

test('a refusal or an API error means "no AI answer", never a crash', async () => {
  process.env.AI_API_KEY = 'k';
  process.env.AI_BASE_URL = baseUrl;
  nextResponse = { status: 200, body: claudeReply('', 'refusal') };
  assert.equal(await ai.answer('hello?'), null);
  nextResponse = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } };
  assert.equal(await ai.answer('hello?'), null);
});

test('OpenAI-compatible providers (OpenAI, Gemini, DeepSeek...) work the same way', async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_API_KEY = 'sk-test';
  process.env.AI_MODEL = 'my-model';
  process.env.AI_BASE_URL = `${baseUrl}/v1/`;
  nextResponse = {
    status: 200,
    body: { choices: [{ message: { content: '```json\n{"answered": true, "reply": "Boil the pouch 3-4 min."}\n```' } }] },
  };
  const result = await ai.answer('How do I heat it?');
  assert.deepEqual(result, { answered: true, reply: 'Boil the pouch 3-4 min.' });
  const req = requests[0];
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-test');
  assert.equal(req.body.model, 'my-model');
  assert.equal(req.body.messages[0].role, 'system');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
});

test('answers are validated before anything is sent', () => {
  assert.deepEqual(ai.parseAnswer('{"answered":true,"reply":" Hi "}'), { answered: true, reply: 'Hi' });
  assert.deepEqual(ai.parseAnswer('{"answered":true,"reply":""}'), { answered: false, reply: '' });
  assert.deepEqual(ai.parseAnswer('{"answered":false,"reply":"guess"}'), { answered: false, reply: '' });
  assert.deepEqual(ai.parseAnswer(`{"answered":true,"reply":"${'x'.repeat(3001)}"}`), { answered: false, reply: '' });
  assert.equal(ai.parseAnswer('not json'), null);
  assert.equal(ai.parseAnswer(''), null);
});

test('product list shows prices, pack sizes and sold-out items', () => {
  const text = ai.formatProducts(
    [
      {
        title: 'Dal Dhokali',
        productType: 'Gujarati',
        description: 'Ready To Eat Dal Dhokali by Thakar Kitchen. 300gms pack. Made with 100% Groundnut Oil. No Preservatives. No Added Colors.',
        variants: [
          { title: '1 Pack', price: '135.00', availableForSale: true },
          { title: 'Pack of 2', price: '235.00', availableForSale: false },
        ],
      },
      { title: 'Udad Dal', productType: 'Gujarati', description: '', variants: [{ title: 'Default Title', price: '125.00', availableForSale: false }] },
    ],
    new Date('2026-09-23T10:00:00Z')
  );
  assert.match(text, /updated 2026-09-23/);
  assert.match(text, /- Dal Dhokali \(Gujarati\): 1 Pack ₹135, Pack of 2 ₹235 \(sold out\)\. 300gms pack\./);
  assert.match(text, /- Udad Dal \(Gujarati\): currently SOLD OUT\. ₹125\./);
  assert.doesNotMatch(text, /Groundnut|Ready To Eat/);
});
