const Customer = require('../models/Customer');

// Tickets and conversations only store the customer's phone number. The Founder
// Inbox is far easier to read when it shows a name, so this looks up the saved
// contact names in one query and attaches `customerName` to each item (empty
// string when we don't have a name yet). Mutates and returns the same array.
async function attachCustomerNames(items) {
  if (!items || items.length === 0) return items;

  const phones = [...new Set(items.map((i) => i.customerPhone).filter(Boolean))];
  const customers = await Customer.find({ phone: { $in: phones } })
    .select('phone name')
    .lean();

  const nameByPhone = new Map(customers.map((c) => [c.phone, c.name || '']));
  for (const item of items) {
    item.customerName = nameByPhone.get(item.customerPhone) || '';
  }
  return items;
}

module.exports = { attachCustomerNames };
