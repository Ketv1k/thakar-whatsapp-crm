const mongoose = require('mongoose');

// WhatsApp message templates: the pre-approved messages needed to message a
// customer first (order updates, reminders, campaigns). Stored in Meta's own
// component format so they can be submitted, rendered and sent as-is.
const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    language: { type: String, default: 'en' },
    // 'UTILITY' | 'MARKETING'
    category: { type: String, required: true },
    components: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Example values for {{1}}, {{2}}..., needed when submitting to Meta.
    examples: { type: [String], default: [] },
    // 'catalog' (built in, for an automation) | 'custom' (made in the app) | 'meta' (made in WhatsApp Manager)
    source: { type: String, default: 'custom' },
    // 'not_submitted' | Meta's status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' ...
    status: { type: String, default: 'not_submitted' },
    rejectedReason: { type: String, default: null },
    metaId: { type: String, default: null },
    submittedAt: Date,
    checkedAt: Date,
    // Human name shown in the app, e.g. "Festive offer".
    label: { type: String, default: '' },
  },
  { timestamps: true }
);

templateSchema.index({ name: 1, language: 1 }, { unique: true });

module.exports = mongoose.model('Template', templateSchema);
