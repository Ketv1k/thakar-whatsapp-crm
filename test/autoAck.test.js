const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const autoAck = require('../src/services/autoAck');

afterEach(() => {
  delete process.env.STORE_URL;
});

test('greetings get the greeting reply', () => {
  for (const m of ['Hi', 'hello!', 'Jai Jinendra', 'Namaste ji', 'Good morning sir']) {
    assert.equal(autoAck.categorize('text', m), 'greeting', m);
  }
});

test('courtesy and emoji-only messages get no reply', () => {
  for (const m of ['ok', 'ok thanks', 'Thank you', 'noted', '👍', '🙏🙏', '...']) {
    assert.equal(autoAck.categorize('text', m), null, m);
  }
});

test('reactions, stickers and locations get no reply', () => {
  for (const type of ['reaction', 'sticker', 'location', 'contacts', 'button']) {
    assert.equal(autoAck.categorize(type, `[${type}]`), null, type);
  }
});

test('photos and voice notes get their own replies', () => {
  assert.equal(autoAck.categorize('image', '[photo]'), 'photo');
  assert.equal(autoAck.categorize('audio', '[audio]'), 'voice');
  assert.equal(autoAck.categorize('video', '[video]'), 'general');
});

test('topics are recognised', () => {
  assert.equal(autoAck.categorize('text', 'Hi, do you have Jain options?'), 'question');
  assert.equal(autoAck.categorize('text', 'What is the price of the thali?'), 'question');
  assert.equal(autoAck.categorize('text', 'I want a bulk order for a family function'), 'bulk');
  assert.equal(autoAck.categorize('text', 'Do you deliver to Pune?'), 'delivery_area');
  assert.equal(autoAck.categorize('text', 'Loved the food, thank you!'), 'praise');
});

test('whole-word matching avoids false hits', () => {
  // "hi" inside "this", "cod" inside "code"
  assert.equal(autoAck.categorize('text', 'this is about my last visit'), 'general');
  assert.equal(autoAck.categorize('text', 'which coupon code works?'), 'question');
});

test('a question is never mistaken for a compliment', () => {
  assert.notEqual(autoAck.categorize('text', 'is it tasty?'), 'praise');
});

test('anything else, including Hindi script, gets the general reply', () => {
  assert.equal(autoAck.categorize('text', 'I have a query about my account'), 'general');
  assert.equal(autoAck.categorize('text', 'मुझे जानकारी चाहिए'), 'general');
});

test('replies exist for every category, menu link only when configured', () => {
  for (const c of ['greeting', 'question', 'bulk', 'delivery_area', 'praise', 'photo', 'voice', 'general']) {
    assert.ok(autoAck.replyFor(c).length > 20, c);
  }
  assert.doesNotMatch(autoAck.replyFor('question'), /http/);
  process.env.STORE_URL = 'https://example.com';
  assert.match(autoAck.replyFor('question'), /https:\/\/example\.com/);
});
