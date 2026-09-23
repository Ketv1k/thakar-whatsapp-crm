// The decision logic behind the support flow we planned:
//   1. Plain "where's my order" questions -> auto-answered from Shopify, no ticket.
//   2. Real issues (damaged, wrong item, missing, genuine delay complaints,
//      refund asks) -> pulled out into a Ticket, separated from general chat.
//   3. Anything else -> left in the general inbox for you to read/reply normally.
//
// Deliberately simple keyword matching - no ML/AI classifier. At this volume
// it's easier to reason about, easier to tune, and fails safe (see the
// "founder can always manually flag" escape hatch in routes/inbox.js).

const STATUS_ONLY_PHRASES = [
  'where is my order',
  "where's my order",
  'track my order',
  'order status',
  'when will it arrive',
  'when will my order',
  'delivery status',
  'has my order shipped',
  'kab aayega',
  'kab milega',
  'order kaha hai',
];

// Order matters a little: refund/complaint language should win over a milder
// "delay" match if both are present in the same message.
const ISSUE_KEYWORD_GROUPS = [
  {
    type: 'damaged',
    keywords: ['damaged', 'damage', 'broken', 'spoiled', 'spoilt', 'leak', 'leaking', 'rotten', 'expired', 'smell', 'moldy', 'mouldy'],
  },
  {
    type: 'wrong_item',
    keywords: ['wrong item', 'wrong product', 'incorrect item', 'mismatch', "that's not what i ordered", 'not what i ordered'],
  },
  {
    type: 'missing',
    keywords: ['missing', 'not received', "didn't receive", 'did not receive', 'item missing', 'short delivery'],
  },
  {
    type: 'payment',
    keywords: ['money deducted', 'amount deducted', 'amount debited', 'money debited', 'payment failed',
      'charged twice', 'double charged', 'paid but', 'payment done but', 'paisa kat gaya', 'paise kat gaye'],
  },
  {
    type: 'refund_request',
    keywords: ['refund', 'replace my order', 'return this', 'compensation', 'complaint'],
  },
  {
    // Unhappy about the food itself. Phrases rather than bare "bad", so
    // "not bad!" doesn't open a ticket.
    type: 'quality',
    keywords: ['bad taste', 'tasted bad', 'tastes bad', 'taste was bad', 'taste is bad', 'stale',
      'not fresh', 'worst', 'disappointed', 'disappointing', 'poor quality', 'not happy', 'horrible',
      'terrible', 'pathetic', 'kharab', 'bekar', 'bakwas'],
  },
  {
    type: 'delay',
    keywords: ['very late', 'still waiting', 'not delivered yet', 'too long', 'many days late', 'extremely delayed'],
  },
];

function normalize(text) {
  return (text || '').toLowerCase().trim();
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * True if the message is a plain status/tracking question with no
 * complaint language mixed in.
 */
function isStatusOnlyQuery(text) {
  const normalized = normalize(text);
  const hasStatusPhrase = containsAny(normalized, STATUS_ONLY_PHRASES);
  const hasIssueKeyword = ISSUE_KEYWORD_GROUPS.some((group) => containsAny(normalized, group.keywords));
  return hasStatusPhrase && !hasIssueKeyword;
}

/**
 * Returns an issue type string (see ISSUE_KEYWORD_GROUPS) if the message
 * describes a real problem, otherwise null.
 */
function detectIssueType(text) {
  const normalized = normalize(text);
  for (const group of ISSUE_KEYWORD_GROUPS) {
    if (containsAny(normalized, group.keywords)) {
      return group.type;
    }
  }
  return null;
}

// Whether a newly created ticket should ask the customer for a photo
// (worth it for anything where seeing the item helps you decide
// refund vs. replace in one glance).
function shouldRequestPhoto(issueType) {
  return ['damaged', 'wrong_item', 'missing'].includes(issueType);
}

function acknowledgmentMessage(ticketNumber, issueType) {
  let msg = `Thanks for letting us know — we've logged this as ticket #${ticketNumber} and our team will follow up shortly.`;
  if (shouldRequestPhoto(issueType)) {
    msg += ' If you can, please reply with a photo of the item — it helps us sort this out faster.';
  } else if (issueType === 'payment') {
    msg += ' If you can, please share the UPI / transaction reference number — it helps us check this faster.';
  }
  return msg;
}

module.exports = {
  isStatusOnlyQuery,
  detectIssueType,
  shouldRequestPhoto,
  acknowledgmentMessage,
};
