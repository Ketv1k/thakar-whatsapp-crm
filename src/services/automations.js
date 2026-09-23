// The automatic WhatsApp messages the founder can switch on and off, and their
// settings. Everything starts OFF. Switching one on records when, so it only
// acts on things that happen from then on (never a burst of old orders).
const settings = require('./settings');

const DEFINITIONS = {
  order_confirmed: { template: 'order_confirmed', marketing: false, options: {} },
  cod_confirmation: { template: 'cod_confirmation', marketing: false, options: {} },
  order_shipped: { template: 'order_shipped', marketing: false, options: {} },
  order_out_for_delivery: { template: 'order_out_for_delivery', marketing: false, options: {} },
  order_delivered: { template: 'order_delivered', marketing: false, options: {} },
  abandoned_cart: { template: 'cart_reminder', marketing: true, options: { delayMinutes: 60 } },
  reorder_reminder: { template: 'reorder_reminder', marketing: true, options: { days: 21 } },
  back_in_stock: { template: 'back_in_stock', marketing: true, options: {} },
};

const OPTION_LIMITS = {
  delayMinutes: [15, 24 * 60],
  days: [7, 90],
};

async function getAll() {
  const stored = await settings.get('automations', {});
  const out = {};
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    const s = stored[key] || {};
    out[key] = {
      key,
      enabled: !!s.enabled,
      enabledAt: s.enabledAt ? new Date(s.enabledAt) : null,
      template: def.template,
      marketing: def.marketing,
      options: { ...def.options, ...(s.options || {}) },
    };
  }
  return out;
}

async function get(key) {
  return (await getAll())[key];
}

async function update(key, { enabled, options } = {}) {
  if (!DEFINITIONS[key]) throw Object.assign(new Error('Unknown automation'), { status: 400, expose: true });
  const current = await get(key);
  const next = { enabled: current.enabled, enabledAt: current.enabledAt, options: current.options };
  if (typeof enabled === 'boolean' && enabled !== current.enabled) {
    next.enabled = enabled;
    next.enabledAt = enabled ? new Date() : null;
  }
  if (options && typeof options === 'object') {
    for (const [k, v] of Object.entries(options)) {
      if (!(k in DEFINITIONS[key].options)) continue;
      const [min, max] = OPTION_LIMITS[k] || [0, Infinity];
      const n = Math.round(Number(v));
      if (Number.isFinite(n)) next.options[k] = Math.min(max, Math.max(min, n));
    }
  }
  await settings.merge('automations', { [key]: next });
  return get(key);
}

// Is the automation on, and was it on when `eventAt` happened?
function activeFor(automation, eventAt) {
  if (!automation || !automation.enabled || !automation.enabledAt) return false;
  if (!eventAt) return true;
  return new Date(eventAt).getTime() >= automation.enabledAt.getTime();
}

module.exports = { DEFINITIONS, getAll, get, update, activeFor };
