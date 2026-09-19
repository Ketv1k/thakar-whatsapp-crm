const { test } = require('node:test');
const assert = require('node:assert/strict');
const triage = require('../src/services/ticketTriage');

// The triage rules from our support flow, checked against representative
// messages including the tricky "status question that's actually a complaint"
// and Hinglish cases.

test('plain status questions auto-answer (no ticket)', () => {
  assert.equal(triage.isStatusOnlyQuery('where is my order'), true);
  assert.equal(triage.isStatusOnlyQuery("Where's my order?"), true);
  assert.equal(triage.isStatusOnlyQuery('order kaha hai bhai'), true);
  assert.equal(triage.detectIssueType('where is my order'), null);
});

test('a complaint mixed into a status question is NOT status-only', () => {
  // "order status but it's damaged" must become a ticket, not an auto-answer.
  assert.equal(triage.isStatusOnlyQuery('order status - it arrived damaged'), false);
  assert.equal(triage.detectIssueType('order status - it arrived damaged'), 'damaged');
});

test('real issues map to the right ticket type', () => {
  assert.equal(triage.detectIssueType('the packet was broken and leaking'), 'damaged');
  assert.equal(triage.detectIssueType('you sent the wrong item'), 'wrong_item');
  assert.equal(triage.detectIssueType('one item is missing from my box'), 'missing');
  assert.equal(triage.detectIssueType('I want a refund please'), 'refund_request');
  assert.equal(triage.detectIssueType('this is still not delivered yet, too long'), 'delay');
});

test('refund/complaint language wins over a milder delay match', () => {
  assert.equal(
    triage.detectIssueType('still waiting and I want a refund'),
    'refund_request'
  );
});

test('general chatter is neither status nor issue', () => {
  assert.equal(triage.isStatusOnlyQuery('do you have gluten free options?'), false);
  assert.equal(triage.detectIssueType('do you have gluten free options?'), null);
  assert.equal(triage.isStatusOnlyQuery('thanks, loved the food!'), false);
  assert.equal(triage.detectIssueType('thanks, loved the food!'), null);
});

test('photo requested only for damaged / wrong_item / missing', () => {
  assert.equal(triage.shouldRequestPhoto('damaged'), true);
  assert.equal(triage.shouldRequestPhoto('wrong_item'), true);
  assert.equal(triage.shouldRequestPhoto('missing'), true);
  assert.equal(triage.shouldRequestPhoto('refund_request'), false);
  assert.equal(triage.shouldRequestPhoto('delay'), false);
});

test('acknowledgment includes ticket number and photo ask when relevant', () => {
  const damaged = triage.acknowledgmentMessage(1042, 'damaged');
  assert.match(damaged, /#1042/);
  assert.match(damaged, /photo/i);

  const refund = triage.acknowledgmentMessage(1043, 'refund_request');
  assert.match(refund, /#1043/);
  assert.doesNotMatch(refund, /photo/i);
});

test('empty / null input is handled without throwing', () => {
  assert.equal(triage.isStatusOnlyQuery(''), false);
  assert.equal(triage.isStatusOnlyQuery(null), false);
  assert.equal(triage.detectIssueType(undefined), null);
});
