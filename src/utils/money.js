// "₹1,151" for rupees (Indian digit grouping), "12.50 USD" otherwise.
function formatMoney(amount, currency = 'INR') {
  const n = Number(amount) || 0;
  if (!currency || currency === 'INR') {
    const rounded = Math.round(n * 100) / 100;
    return `₹${rounded.toLocaleString('en-IN', { maximumFractionDigits: rounded % 1 ? 2 : 0 })}`;
  }
  return `${n.toFixed(2)} ${currency}`;
}

module.exports = { formatMoney };
