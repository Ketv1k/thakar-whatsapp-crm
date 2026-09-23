// Customer tags typed by the founder. Keeps them tidy so "jain", "Jain " and
// "JAIN" don't become three different tags.
const MAX_TAGS = 20;
const MAX_LENGTH = 30;

function cleanTag(tag) {
  const t = String(tag == null ? '' : tag)
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH);
  if (!t) return '';
  // Capitalise the first letter; leave the rest as typed ("COD", "iPhone").
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const t = cleanTag(raw);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

module.exports = { cleanTag, cleanTags, MAX_TAGS, MAX_LENGTH };
