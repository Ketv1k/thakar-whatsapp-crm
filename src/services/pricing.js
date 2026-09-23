// What WhatsApp messages cost, for the estimates shown in the app. Meta's India
// rates effective 1 July 2026, per delivered template message, before 18% GST.
// Utility templates (order updates) are free when the customer messaged you in
// the last 24 hours. Override with WA_PRICE_MARKETING / WA_PRICE_UTILITY if
// Meta changes them.
const GST = 0.18;

function rate(category) {
  if (category === 'MARKETING') return Number(process.env.WA_PRICE_MARKETING || 0.8631);
  if (category === 'UTILITY' || category === 'AUTHENTICATION') return Number(process.env.WA_PRICE_UTILITY || 0.115);
  return 0;
}

// { each, total } in rupees including GST.
function estimate(count, category) {
  const each = rate(category) * (1 + GST);
  return { each: Math.round(each * 100) / 100, total: Math.round(each * count * 100) / 100 };
}

module.exports = { rate, estimate, GST };
