const test = require('node:test');
const assert = require('node:assert');
const segments = require('../src/services/segments');
const { summarize } = require('../src/services/customerInsights');
const { parseCsv, readList } = require('../src/services/contactImport');
const { chatDays } = require('../src/services/customerTimeline');
const { detectKeyword } = require('../src/services/optIn');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-24T08:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

// Just enough of MongoDB's matching to check the stage queries.
function matches(doc, query) {
  return Object.entries(query).every(([key, cond]) => {
    if (key === '$or') return cond.some((q) => matches(doc, q));
    if (key === '$and') return cond.every((q) => matches(doc, q));
    const value = doc[key] === undefined ? null : doc[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, arg]) => {
        const v = value instanceof Date ? value.getTime() : value;
        const a = arg instanceof Date ? arg.getTime() : arg;
        if (op === '$gte') return v != null && v >= a;
        if (op === '$lt') return v != null && v < a;
        if (op === '$ne') return v !== a;
        throw new Error(`unsupported ${op}`);
      });
    }
    const v = value instanceof Date ? value.getTime() : value;
    const c = cond instanceof Date ? cond.getTime() : cond;
    return v === c;
  });
}

test('every customer who ordered is in exactly one stage, the same one their profile shows', () => {
  const stages = segments.STAGES.map((s) => s.key).filter((k) => k !== 'all');
  let checked = 0;
  for (const ordersCount of [0, 1, 2, 6]) {
    for (const days of [null, 1, 29, 31, 60, 100, 121, 150, 179, 181, 400]) {
      for (const status of ['new', 'returning', 'vip']) {
        const c = { ordersCount, lastOrderAt: days == null ? null : daysAgo(days), status };
        if (ordersCount === 0 && days != null) continue;
        if (ordersCount > 0 && days == null) continue;
        const inStages = stages.filter((k) => matches(c, segments.segmentQuery(k, NOW)));
        assert.equal(inStages.length, 1, `${JSON.stringify(c)} is in ${inStages.join(', ') || 'no stage'}`);
        assert.equal(inStages[0], segments.stageOf(c, NOW), JSON.stringify(c));
        checked++;
      }
    }
  }
  assert.ok(checked > 50);
});

test('stages in plain terms', () => {
  const s = (ordersCount, days, status = 'new') => segments.stageOf({ ordersCount, lastOrderAt: daysAgo(days), status }, NOW);
  assert.equal(s(1, 10), 'new');
  assert.equal(s(1, 45), 'second_order');
  assert.equal(s(1, 130), 'lost');
  assert.equal(s(3, 20, 'returning'), 'loyal');
  assert.equal(s(3, 120, 'returning'), 'at_risk');
  assert.equal(s(3, 200, 'returning'), 'lost');
  assert.equal(s(8, 150, 'vip'), 'vip');
  assert.equal(s(8, 200, 'vip'), 'lost');
  assert.equal(segments.stageOf({ ordersCount: 0, lastOrderAt: null }, NOW), 'no_orders');
});

test('filters: only known values are kept, and read back in plain words', () => {
  const f = segments.cleanFilters(
    JSON.stringify({ bought: 'Kaju Curry', minSpent: 2500, orders: '2+', lastOrder: '90+', pays: 'cod', place: 'Ahmedabad', offers: 'yes', birthday: 'month', evil: { $where: '1' }, minSpent2: 5 })
  );
  assert.deepEqual(Object.keys(f).sort(), ['birthday', 'bought', 'lastOrder', 'minSpent', 'offers', 'orders', 'pays', 'place']);
  assert.deepEqual(segments.cleanFilters({ minSpent: 1234, orders: '7', lastOrder: 'x', pays: 'cash' }), {});
  assert.deepEqual(segments.cleanFilters('not json'), {});
  assert.equal(
    segments.describeFilters({ bought: 'Kaju Curry', minSpent: 2500, pays: 'cod' }),
    'Bought Kaju Curry · ₹2,500+ spent · Mostly pays COD'
  );
});

test('filters become a database query', () => {
  const q = segments.customerFilter({ segment: 'all', filters: { bought: 'Kaju Curry', notBought: 'Dal Tadka', minSpent: 1000, place: 'a.b' } }, NOW);
  assert.deepEqual(q.$and[0], { products: 'Kaju Curry' });
  assert.deepEqual(q.$and[1], { products: { $ne: 'Dal Tadka' } });
  assert.deepEqual(q.$and[2], { totalSpent: { $gte: 1000 } });
  // Typed text is matched literally, not as a pattern.
  assert.equal(q.$and[3].$or[0].city.source, 'a\\.b');
  const bday = segments.customerFilter({ filters: { birthday: 'month' } }, NOW);
  assert.deepEqual(bday, { birthday: { $regex: '^09-' } });
  // The older tag parameter still works.
  assert.deepEqual(segments.customerFilter({ segment: 'opted_in', tag: 'Jain' }), { $and: [{ optedInMarketing: true }, { tags: 'Jain' }] });
});

test('customer numbers from their orders', () => {
  const orders = [
    { phone: '91A', placedAt: daysAgo(90), isCod: true, items: [{ title: 'Kaju Curry', quantity: 2 }, { title: 'Methi Papad', quantity: 1 }] },
    { phone: '91A', placedAt: daysAgo(60), isCod: false, items: [{ title: 'Kaju Curry', quantity: 1 }] },
    { phone: '91A', placedAt: daysAgo(30), isCod: false, items: [{ title: 'Dal Tadka', quantity: 1 }] },
    { phone: '91A', placedAt: daysAgo(10), isCod: true, cancelledAt: daysAgo(9), items: [{ title: 'Undhiyu', quantity: 5 }] },
    { phone: '91B', placedAt: daysAgo(5), isCod: false, items: [{ title: 'Methi Papad', quantity: 1 }] },
    { phone: null, placedAt: daysAgo(5), items: [] },
  ];
  const n = summarize(orders);
  const a = n.get('91A');
  assert.deepEqual(a.products, ['Dal Tadka', 'Kaju Curry', 'Methi Papad']);
  assert.deepEqual(a.favourites, ['Kaju Curry', 'Dal Tadka', 'Methi Papad']);
  assert.equal(a.avgGapDays, 30);
  assert.equal(a.codOrders, 1);
  assert.equal(a.prepaidOrders, 2);
  assert.equal(a.codCancelled, 1);
  assert.equal(n.get('91B').avgGapDays, null);
  assert.equal(n.size, 2);
});

test('CSV files: quotes, other separators and a byte-order mark', () => {
  assert.deepEqual(parseCsv('﻿Name,Phone\r\n"Shah, Priya","+91 98765 43210"\r\n"Said ""hi""",9876500000\n'), [
    ['Name', 'Phone'],
    ['Shah, Priya', '+91 98765 43210'],
    ['Said "hi"', '9876500000'],
  ]);
  assert.deepEqual(parseCsv('name;mobile\nAsha;9876543210'), [['name', 'mobile'], ['Asha', '9876543210']]);
});

test('importing a list finds the phone column, skips repeats and respects an opt-in column', () => {
  const zoko = [
    'Contact Name,WhatsApp Number,Opt-in Status,City',
    'Priya Shah,+91 98765 43210,Opted In,Surat',
    'Rahul,98765 43211,no,Rajkot',
    'Priya again,919876543210,yes,Surat',
    'Nobody,not a number,yes,',
  ].join('\n');
  const list = readList(zoko);
  assert.deepEqual(list.columns, { phone: 'WhatsApp Number', name: 'Contact Name', optIn: 'Opt-in Status' });
  assert.deepEqual(list.people, [
    { phone: '919876543210', name: 'Priya Shah', agreed: true },
    { phone: '919876543211', name: 'Rahul', agreed: false },
  ]);
  assert.equal(list.duplicates, 1);
  assert.equal(list.invalid, 1);
  // No telling headers: the column that looks like phone numbers.
  const plain = readList('a,b\nAsha,9876543210\nRavi,9876543212');
  assert.equal(plain.columns.phone, 'b');
  assert.equal(plain.people[0].agreed, null);
  assert.match(readList('Name,Email\nAsha,a@b.c').error, /phone numbers/);
  assert.match(readList('').error, /empty/);
});

test('history groups a chat into one line per day', () => {
  const days = chatDays([
    { direction: 'inbound', body: 'Is kaju curry spicy?', createdAt: new Date('2026-09-20T05:00:00Z') },
    { direction: 'outbound', body: 'Mildly', createdAt: new Date('2026-09-20T06:00:00Z') },
    { direction: 'inbound', body: 'Thanks', createdAt: new Date('2026-09-20T07:00:00Z') },
    { direction: 'inbound', body: 'Hi again', createdAt: new Date('2026-09-22T07:00:00Z') },
  ]);
  assert.equal(days.length, 2);
  assert.equal(days[0].text, 'WhatsApp chat · 2 from them, 1 from you');
  assert.equal(days[0].detail, '“Is kaju curry spicy?”');
});

test('the offers link message opts people in', () => {
  assert.equal(detectKeyword('Yes, send me offers'), 'start');
  assert.equal(detectKeyword('yes send me offers!'), 'start');
  assert.equal(detectKeyword('Yes, send me the bill'), null);
});
