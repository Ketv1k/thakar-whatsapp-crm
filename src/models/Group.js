const mongoose = require('mongoose');

// A customer group the founder saved on the Customers page: a stage plus
// filters (services/segments.js), under a name. Membership is worked out
// fresh each time, so a group always has the right people in it.
const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    segment: { type: String, default: 'all' },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Group', groupSchema);
