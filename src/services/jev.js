// Jev (TypeSafe AI) reads customer messages the keyword rules in
// ticketTriage.js don't recognise - Hinglish, Gujarati, long or oddly worded
// ones - and says what the customer wants: an order-status question, a
// problem (which becomes a ticket), or something else. It also says how upset
// they are. Jev only picks from fixed options; it never writes text, so
// replies still come from the templates here or from aiAnswer.js.
//
// Off unless TYPESAFE_API_KEY is set. Any failure means "no opinion" and the
// message is handled exactly as it would be without Jev.

const KINDS = {
  order_status: 'Only asking where their order is or when it will arrive, with no complaint',
  problem:
    'Something went wrong with an order: damaged, leaking or wrong items, something missing, bad or stale food, money deducted or charged twice, wants a refund or replacement, or the order is very late',
  question: 'A question about products, prices, ingredients, delivery areas, stores or how to order',
  bulk: 'Wants a bulk, party, wedding, gifting or corporate order',
  praise: 'Thanks or compliments',
  other: 'Anything else, including greetings',
};

const ISSUES = {
  damaged: 'The package or food arrived damaged, broken, leaking or spoiled',
  wrong_item: 'They got a different product from what they ordered',
  missing: 'The order or some items never arrived',
  payment: 'Money was deducted, charged twice, or a payment failed',
  refund_request: 'Asks for a refund, return, replacement or compensation',
  quality: 'Unhappy with the taste, freshness or quality of the food',
  delay: 'Complains the order is very late',
  other: 'Some other problem',
};

const UPSET = ['Calm, happy or neutral', 'A little annoyed', 'Angry or very upset'];

const CONTEXT =
  'A WhatsApp message from a customer of Thakar Kitchen, an Indian food brand that sells ready-to-cook curries, snacks and papad online. It may be in English, Hindi, Gujarati or a mix (Hinglish).';

// Jev must be at least this sure before it overrides the normal handling.
const MIN_CONFIDENCE = 0.75;
// Upset score (0 calm, 1 annoyed, 2 angry) from which the team is told.
const UPSET_FROM = 1.5;

let client = null;

function isConfigured() {
  return !!String(process.env.TYPESAFE_API_KEY || '').trim();
}

function status() {
  return { enabled: isConfigured(), model: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest' };
}

function getClient() {
  if (!client) {
    const { TypeSafeClient } = require('@typesafe-ai/sdk');
    // Short: the customer is waiting for the reply this decides.
    client = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, logLevel: 'error' });
  }
  return client;
}

function questions() {
  const { choice, score } = require('@typesafe-ai/sdk');
  return {
    kind: choice('What does the customer want?', KINDS),
    issue: choice('If something went wrong with their order, what was it?', ISSUES),
    upset: score('How upset is the customer?', UPSET),
  };
}

// What Jev thinks of one message, or null (not set up, empty, or it failed).
async function readMessage(text, { jevClient } = {}) {
  const message = String(text || '').trim().slice(0, 2000);
  if (!message || (!jevClient && !isConfigured())) return null;
  try {
    const res = await (jevClient || getClient()).systemOne({ state: { context: CONTEXT, message }, questions: questions() });
    const a = res.answers;
    return {
      kind: a.kind.choice,
      confidence: Math.round(a.kind.confidence * 100) / 100,
      issue: a.issue.choice,
      upset: Math.round(a.upset.score * 100) / 100,
      model: res.model,
    };
  } catch (err) {
    console.error('[jev] could not read the message:', err.status || '', err.message);
    return null;
  }
}

// Pure: what to do with a message the keyword rules didn't recognise.
function decide(reading) {
  if (!reading) return { action: null, upset: false };
  const upset = reading.upset >= UPSET_FROM;
  if (reading.confidence < MIN_CONFIDENCE) return { action: null, upset };
  if (reading.kind === 'problem') return { action: 'ticket', issueType: ISSUES[reading.issue] ? reading.issue : 'other', upset };
  if (reading.kind === 'order_status') return { action: 'status', upset };
  return { action: null, upset };
}

module.exports = { isConfigured, status, readMessage, decide, MIN_CONFIDENCE, UPSET_FROM };
