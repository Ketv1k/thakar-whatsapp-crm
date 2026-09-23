const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const whatsapp = require('../src/services/whatsapp');

const realCreate = axios.create;

beforeEach(() => {
  process.env.TEST_MODE = 'true';
  axios.create = () => {
    throw new Error('network call attempted in test mode');
  };
});

afterEach(() => {
  delete process.env.TEST_MODE;
  axios.create = realCreate;
});

test('test mode never contacts WhatsApp when replying', async () => {
  const res = await whatsapp.sendTextMessage('919876543210', 'hello');
  assert.match(res.messages[0].id, /^wamid\.TEST\./);
});

test('test mode never contacts WhatsApp for templates or read receipts', async () => {
  const res = await whatsapp.sendTemplateMessage('919876543210', 'order_update');
  assert.match(res.messages[0].id, /^wamid\.TEST\./);
  await whatsapp.markMessageRead('wamid.abc');
});

test('outside test mode, sending does try WhatsApp', async () => {
  delete process.env.TEST_MODE;
  process.env.WHATSAPP_TOKEN = 't';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1';
  await assert.rejects(() => whatsapp.sendTextMessage('919876543210', 'hi'), /network call attempted/);
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});
