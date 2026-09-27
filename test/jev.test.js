const test = require('node:test');
const assert = require('node:assert');
const { TypeSafeClient } = require('@typesafe-ai/sdk');
const jev = require('../src/services/jev');

// A real client whose "network" is this function.
function fakeJev(reply) {
  const calls = [];
  const client = new TypeSafeClient({
    apiKey: 'test-key',
    logLevel: 'off',
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return typeof reply === 'function' ? reply() : new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, calls };
}

const answer = (kind, confidence, issue, upset) => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 300, output_tokens: 0 },
  answers: {
    kind: { type: 'choice', choice: kind, confidence, probabilities: {} },
    issue: { type: 'choice', choice: issue, confidence: 0.9, probabilities: {} },
    upset: { type: 'score', score: upset, confidence: 0.8, legend: {}, probabilities: {} },
  },
});

test('Jev is asked what the customer wants, what went wrong and how upset they are', async () => {
  const { client, calls } = fakeJev(answer('problem', 0.914, 'damaged', 1.72));
  const reading = await jev.readMessage('bhai dabba puru tuti gayu che, badhu dholai gayu', { jevClient: client });
  assert.deepEqual(reading, { kind: 'problem', confidence: 0.91, issue: 'damaged', upset: 1.72, model: 'jev-1.13.0' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/systemone$/);
  const body = calls[0].body;
  assert.equal(body.state.message, 'bhai dabba puru tuti gayu che, badhu dholai gayu');
  assert.deepEqual(Object.keys(body.questions), ['kind', 'issue', 'upset']);
  assert.equal(body.questions.kind.type, 'choice');
  assert.ok(body.questions.kind.criteria.order_status && body.questions.kind.criteria.problem);
  assert.equal(body.questions.upset.type, 'score');
  assert.equal(body.questions.upset.criteria.length, 3);
});

test('if Jev fails, or has no key, the message is handled as before', async () => {
  const { client } = fakeJev(() => new Response('{"detail":"down"}', { status: 500 }));
  assert.equal(await jev.readMessage('where is my parcel', { jevClient: client }), null);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(jev.isConfigured(), false);
  assert.equal(await jev.readMessage('where is my parcel'), null);
  assert.equal(await jev.readMessage('   ', { jevClient: client }), null);
});

test('what the app does with what Jev says', () => {
  const r = (kind, confidence, issue = 'other', upset = 0) => ({ kind, confidence, issue, upset });
  assert.deepEqual(jev.decide(null), { action: null, upset: false });
  assert.deepEqual(jev.decide(r('problem', 0.9, 'missing')), { action: 'ticket', issueType: 'missing', upset: false });
  assert.deepEqual(jev.decide(r('problem', 0.9, 'something new')), { action: 'ticket', issueType: 'other', upset: false });
  assert.deepEqual(jev.decide(r('order_status', 0.8)), { action: 'status', upset: false });
  // Not sure enough: left to the normal handling.
  assert.deepEqual(jev.decide(r('problem', 0.6, 'damaged')), { action: null, upset: false });
  // Questions and the rest go on to the AI answer / acknowledgment...
  assert.deepEqual(jev.decide(r('question', 0.95)), { action: null, upset: false });
  // ...unless the customer sounds angry, which is flagged even when unsure.
  assert.deepEqual(jev.decide(r('other', 0.5, 'other', 1.8)), { action: null, upset: true });
  assert.equal(jev.decide(r('question', 0.9, 'other', 1.2)).upset, false);
});
