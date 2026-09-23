const test = require('node:test');
const assert = require('node:assert');
const { describeInbound } = require('../src/services/messageContent');
const { statusChange } = require('../src/services/deliveryStatus');
const { windowClosesAt, isWindowOpen } = require('../src/services/replyWindow');
const { cleanTags } = require('../src/services/tags');
const { parseSearch, isOverdue, startOfTodayIndia } = require('../src/services/inboxView');

test('text messages keep their text as body and preview', () => {
  const d = describeInbound({ type: 'text', text: { body: 'Where is my order?' } });
  assert.equal(d.body, 'Where is my order?');
  assert.equal(d.preview, 'Where is my order?');
  assert.equal(d.media, null);
});

test('photos keep the media id and use the caption as text', () => {
  const d = describeInbound({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'Box broken' } });
  assert.equal(d.body, 'Box broken');
  assert.equal(d.caption, 'Box broken');
  assert.equal(d.preview, '📷 Photo: Box broken');
  assert.deepEqual(d.media, { id: 'm1', mimeType: 'image/jpeg', filename: '', voice: false });

  const bare = describeInbound({ type: 'image', image: { id: 'm2' } });
  assert.equal(bare.body, '[photo]');
  assert.equal(bare.preview, '📷 Photo');
});

test('voice notes, files and reactions get readable previews', () => {
  const v = describeInbound({ type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg', voice: true } });
  assert.equal(v.preview, '🎤 Voice message');
  assert.equal(v.media.voice, true);

  const f = describeInbound({ type: 'document', document: { id: 'd1', filename: 'bill.pdf' } });
  assert.equal(f.preview, '📄 File');
  assert.equal(f.media.filename, 'bill.pdf');

  const r = describeInbound({ type: 'reaction', reaction: { emoji: '👍' } });
  assert.equal(r.preview, 'Reacted 👍');

  const b = describeInbound({ type: 'button', button: { text: 'Confirm order' } });
  assert.equal(b.body, 'Confirm order');
});

test('delivery ticks only move forward', () => {
  const read = statusChange({ id: 'w1', status: 'read', timestamp: '1700000000' });
  assert.deepEqual(read.filter.status.$in, [null, 'queued', 'sent', 'delivered', 'failed']);
  assert.equal(read.update.$set.status, 'read');
  assert.equal(read.update.$set.statusAt.getTime(), 1700000000 * 1000);

  const delivered = statusChange({ id: 'w1', status: 'delivered' });
  assert.ok(!delivered.filter.status.$in.includes('read'));

  const failed = statusChange({ id: 'w1', status: 'failed', errors: [{ title: 'Re-engagement message' }] });
  assert.equal(failed.update.$set.status, 'failed');
  assert.equal(failed.update.$set.statusError, 'Re-engagement message');
  assert.deepEqual(failed.filter.status, { $ne: 'read' });

  assert.equal(statusChange({ id: 'w1', status: 'deleted' }), null);
  assert.equal(statusChange({ status: 'read' }), null);
});

test('reply window is 24 hours from the customer\'s last message', () => {
  const last = new Date('2026-09-23T10:00:00Z');
  assert.equal(windowClosesAt(last).toISOString(), '2026-09-24T10:00:00.000Z');
  assert.equal(isWindowOpen(last, Date.parse('2026-09-24T09:59:00Z')), true);
  assert.equal(isWindowOpen(last, Date.parse('2026-09-24T10:01:00Z')), false);
  assert.equal(isWindowOpen(null), false);
});

test('tags are trimmed, capitalised and de-duplicated', () => {
  assert.deepEqual(cleanTags([' jain ', 'Jain', 'JAIN', '', null, 'monthly  buyer', 'COD']), ['Jain', 'Monthly buyer', 'COD']);
  assert.deepEqual(cleanTags('jain'), []);
  assert.equal(cleanTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 20);
  assert.equal(cleanTags(['x'.repeat(50)])[0].length, 30);
});

test('search understands ticket numbers, phone digits and names', () => {
  assert.equal(parseSearch('#1042').ticketNumber, 1042);
  assert.equal(parseSearch('1042').ticketNumber, 1042);
  assert.equal(parseSearch('1042').phoneDigits, '1042');
  const phone = parseSearch('+91 98765 43210');
  assert.equal(phone.phoneDigits, '919876543210');
  assert.equal(phone.ticketNumber, null);
  const name = parseSearch('priya (vip)');
  assert.ok(name.nameRegex.test('Priya (VIP) Shah'));
  assert.equal(name.phoneDigits, null);
  assert.equal(parseSearch('   '), null);
});

test('overdue follows the SLA hours and ignores resolved tickets', () => {
  process.env.SLA_HOURS = '6';
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(isOverdue({ status: 'open', lastActivityAt: '2026-09-23T05:00:00Z' }, now), true);
  assert.equal(isOverdue({ status: 'open', lastActivityAt: '2026-09-23T07:00:00Z' }, now), false);
  assert.equal(isOverdue({ status: 'resolved', lastActivityAt: '2026-09-20T00:00:00Z' }, now), false);
});

test('"today" starts at midnight India time', () => {
  // 23 Sep 20:00 UTC is 24 Sep 01:30 in India.
  assert.equal(startOfTodayIndia(new Date('2026-09-23T20:00:00Z')).toISOString(), '2026-09-23T18:30:00.000Z');
  assert.equal(startOfTodayIndia(new Date('2026-09-23T10:00:00Z')).toISOString(), '2026-09-22T18:30:00.000Z');
});
