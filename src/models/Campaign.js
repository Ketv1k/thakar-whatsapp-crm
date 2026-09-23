const mongoose = require('mongoose');

// A broadcast: one approved template sent to a group of opted-in customers,
// now or at a scheduled time. Each recipient's copy is a Message with this
// campaignId, which is how delivery, reads, replies and orders are counted.
const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed'
    status: { type: String, default: 'draft', index: true },
    audience: {
      segment: { type: String, default: 'all' },
      tag: { type: String, default: '' },
    },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    // What fills each {{n}}: [{ source: 'first_name' | 'text', text: '...' }]
    bodyParams: { type: [mongoose.Schema.Types.Mixed], default: [] },
    headerImageUrl: { type: String, default: '' },
    scheduledAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    counts: {
      audience: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    lastError: { type: String, default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Campaign', campaignSchema);
