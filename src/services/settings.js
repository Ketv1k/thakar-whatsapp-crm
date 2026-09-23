// Tiny key/value store on top of the Setting collection.
const Setting = require('../models/Setting');

async function get(key, fallback = {}) {
  const doc = await Setting.findById(key).lean();
  return doc && doc.value != null ? doc.value : fallback;
}

// Merges `patch` into the stored object (one level deep per call site's needs).
async function merge(key, patch) {
  const $set = {};
  for (const [k, v] of Object.entries(patch)) $set[`value.${k}`] = v;
  await Setting.updateOne({ _id: key }, { $set }, { upsert: true });
  return get(key);
}

async function set(key, value) {
  await Setting.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
  return value;
}

module.exports = { get, merge, set };
