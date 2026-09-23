const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const status = require('../src/services/customerStatus');

afterEach(() => {
  delete process.env.CRM_RETURNING_ORDERS;
  delete process.env.CRM_VIP_ORDERS;
  delete process.env.CRM_VIP_SPEND;
});

test('no orders is a new customer', () => {
  assert.equal(status.classify(0, 0), 'new');
  assert.equal(status.classify(1, 350), 'new');
});

test('two or more orders is returning', () => {
  assert.equal(status.classify(2, 700), 'returning');
  assert.equal(status.classify(4, 2000), 'returning');
});

test('many orders makes a VIP', () => {
  assert.equal(status.classify(5, 1200), 'vip');
  assert.equal(status.classify(9, 3000), 'vip');
});

test('high lifetime spend makes a VIP even with few orders', () => {
  assert.equal(status.classify(3, 6000), 'vip');
});

test('thresholds are env-tunable', () => {
  process.env.CRM_VIP_ORDERS = '3';
  assert.equal(status.classify(3, 100), 'vip');
  process.env.CRM_VIP_SPEND = '999999';
  process.env.CRM_VIP_ORDERS = '99';
  assert.equal(status.classify(10, 50000), 'returning');
});

test('handles missing / non-numeric input', () => {
  assert.equal(status.classify(undefined, undefined), 'new');
  assert.equal(status.classify(null, null), 'new');
});

test('labels are human-friendly', () => {
  assert.equal(status.statusLabel('new'), 'New customer');
  assert.equal(status.statusLabel('returning'), 'Returning');
  assert.equal(status.statusLabel('vip'), 'VIP');
});
