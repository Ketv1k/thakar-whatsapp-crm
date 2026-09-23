const mongoose = require('mongoose');

// Small bits of app state that aren't secrets: which automations are switched
// on (and since when), sync checkpoints, opt-in choices. One document per key,
// e.g. { _id: 'automations', value: { order_shipped: { enabled: true, ... } } }.
const settingSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Setting', settingSchema);
