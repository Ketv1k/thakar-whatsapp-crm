// Importing a list of customers from a CSV file (e.g. a Zoko export): finds
// the phone and name columns by itself, and can opt people in to offers when
// the founder confirms they agreed. If the file has an opt-in column, only
// the rows marked yes are opted in. Anyone who replied STOP stays out.
const Customer = require('../models/Customer');
const { normalizePhone } = require('../utils/phone');
const { cleanTags } = require('./tags');
const { queueChange } = require('./shopifyLive');

const MAX_ROWS = 50000;

// Minimal CSV reader: quotes, escaped quotes, commas/semicolons/tabs, CRLF.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_ROWS) break;
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const YES = /^(y|yes|true|1|opted[ _-]?in|subscribed|granted|active|allowed)$/i;

// Which columns hold the phone, the name and (if any) an opt-in answer.
function detectColumns(rows) {
  const header = (rows[0] || []).map((h) => String(h).trim());
  const body = rows.slice(1, 200);
  const phoneShare = (i) => (body.length ? body.filter((r) => normalizePhone(r[i])).length / body.length : 0);
  let phone = header.findIndex((h, i) => /phone|mobile|whats ?app|number|contact|msisdn|wa[ _]?id/i.test(h) && phoneShare(i) > 0.5);
  if (phone < 0) {
    // No telling header: the column that looks most like phone numbers.
    let best = 0;
    header.forEach((h, i) => {
      const share = phoneShare(i);
      if (share > best && share > 0.5) {
        best = share;
        phone = i;
      }
    });
  }
  let name = header.findIndex((h) => /^(full[ _]?)?name$|customer[ _]?name|contact[ _]?name|display[ _]?name/i.test(h));
  if (name < 0) name = header.findIndex((h, i) => i !== phone && /name/i.test(h));
  const optIn = header.findIndex((h) => /opt.?in|subscri|consent|marketing/i.test(h));
  return { header, phone, name, optIn };
}

// Reads the file into clean rows: [{ phone, name, agreed }] (agreed is null
// when the file has no opt-in column).
function readList(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: 'The file looks empty. Export it as a CSV with a header row.' };
  const cols = detectColumns(rows);
  if (cols.phone < 0) return { error: "Couldn't find a column of phone numbers in this file." };
  const seen = new Set();
  let invalid = 0;
  let duplicates = 0;
  const people = [];
  for (const r of rows.slice(1)) {
    const phone = normalizePhone(r[cols.phone]);
    if (!phone) {
      invalid++;
      continue;
    }
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    seen.add(phone);
    people.push({
      phone,
      name: cols.name >= 0 ? String(r[cols.name] || '').trim().slice(0, 120) : '',
      agreed: cols.optIn >= 0 ? YES.test(String(r[cols.optIn] || '').trim()) : null,
    });
  }
  return {
    people,
    invalid,
    duplicates,
    columns: {
      phone: cols.header[cols.phone],
      name: cols.name >= 0 ? cols.header[cols.name] : null,
      optIn: cols.optIn >= 0 ? cols.header[cols.optIn] : null,
    },
  };
}

// Preview (dryRun) or apply an import.
async function importList({ csv, optIn = false, tag = '', dryRun = true }) {
  const list = readList(csv);
  if (list.error) return list;
  const phones = list.people.map((p) => p.phone);
  const existing = new Map();
  for (let i = 0; i < phones.length; i += 5000) {
    const found = await Customer.find({ phone: { $in: phones.slice(i, i + 5000) } }).select('phone name optedInMarketing optedOutAt tags shopifyCustomerId shopifyPush').lean();
    for (const c of found) existing.set(c.phone, c);
  }
  const summary = {
    rows: list.people.length + list.invalid + list.duplicates,
    people: list.people.length,
    invalid: list.invalid,
    duplicates: list.duplicates,
    columns: list.columns,
    newCustomers: 0,
    willOptIn: 0,
    alreadyOptedIn: 0,
    stopped: 0,
    notAgreed: 0,
  };
  const now = new Date();
  const tags = cleanTags([tag]);
  const ops = [];
  for (const p of list.people) {
    const c = existing.get(p.phone);
    if (!c) summary.newCustomers++;
    let optInThis = false;
    if (optIn) {
      if (c && c.optedOutAt) summary.stopped++;
      else if (c && c.optedInMarketing) summary.alreadyOptedIn++;
      else if (p.agreed === false) summary.notAgreed++;
      else {
        summary.willOptIn++;
        optInThis = true;
      }
    }
    const $set = {};
    if (p.name && (!c || !c.name || c.name === p.phone)) $set.name = p.name;
    if (optInThis) Object.assign($set, { optedInMarketing: true, optInSource: 'import', optedInAt: now });
    // A new tag on a Shopify customer goes to Shopify too.
    const newTags = c ? tags.filter((t) => !(c.tags || []).some((x) => x.toLowerCase() === t.toLowerCase())) : [];
    if (c && c.shopifyCustomerId && newTags.length) $set.shopifyPush = queueChange(c.shopifyPush, { added: newTags });
    const update = { $setOnInsert: { phone: p.phone } };
    if (Object.keys($set).length) update.$set = $set;
    if (tags.length) update.$addToSet = { tags: { $each: tags } };
    ops.push({ updateOne: { filter: { phone: p.phone }, update, upsert: true } });
  }
  if (!dryRun) {
    for (let i = 0; i < ops.length; i += 1000) await Customer.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
  return { ...summary, done: !dryRun };
}

module.exports = { parseCsv, detectColumns, readList, importList };
