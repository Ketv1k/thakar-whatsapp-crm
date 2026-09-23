// One shape for phone numbers everywhere: digits only, with country code,
// e.g. "919876543210" - the way WhatsApp sends them in webhooks. Shopify has
// "+91 98765 43210", "09876543210" or just "9876543210"; all become the same.
const DEFAULT_COUNTRY = '91';

function normalizePhone(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2); // 0091...
  // Indian numbers written without the country code: 98765 43210 / 098765 43210.
  if (defaultCountry === '91') {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10 && /^[6-9]/.test(digits)) digits = `91${digits}`;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

module.exports = { normalizePhone };
