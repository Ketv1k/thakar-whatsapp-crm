// Time helpers for a business in India (one time zone, no daylight saving,
// so +5:30 is fixed).
const IST_OFFSET_MS = 330 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function startOfTodayIndia(now = new Date()) {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

// Hour of the day in India, 0-23.
function indiaHour(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCHours();
}

// Promotional messages (cart reminders, reorder nudges, restock alerts) only go
// out in the daytime. QUIET_HOURS="21-9" means 9pm to 9am India time is quiet.
function quietHours() {
  const m = String(process.env.QUIET_HOURS || '21-9').match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return { start: 21, end: 9 };
  return { start: Number(m[1]) % 24, end: Number(m[2]) % 24 };
}

function isQuietTime(date = new Date()) {
  const { start, end } = quietHours();
  if (start === end) return false;
  const h = indiaHour(date);
  return start > end ? h >= start || h < end : h >= start && h < end;
}

module.exports = { startOfTodayIndia, indiaHour, isQuietTime, quietHours, HOUR, DAY, IST_OFFSET_MS };
