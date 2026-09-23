// Instant acknowledgments for messages the app can't answer on its own - i.e.
// anything that isn't an order-status question (answered from Shopify) or a
// problem (turned into a ticket). The customer hears back right away with a
// reply that fits what they sent, while the message waits in Chats.
//
// Keyword-based, like ticketTriage.js: easy to read and tune.

// Messages made only of these words ("ok thanks", "noted") need no reply.
const COURTESY_WORDS = new Set([
  'ok', 'okay', 'okk', 'k', 'kk', 'thanks', 'thank', 'you', 'thankyou', 'thanx', 'thnx', 'thx', 'ty',
  'noted', 'sure', 'great', 'cool', 'fine', 'alright', 'done', 'got', 'it', 'yes', 'yeah', 'ya', 'yep',
  'no', 'hmm', 'welcome', 'nice', 'good', 'perfect', 'ji', 'haan', 'theek', 'hai', 'accha', 'acha',
]);

// Messages made only of these words ("hi", "jai jinendra") are greetings.
const GREETING_WORDS = new Set([
  'hi', 'hii', 'hiii', 'hello', 'helo', 'hey', 'heyy', 'namaste', 'namaskar', 'jai', 'jinendra',
  'shree', 'shri', 'krishna', 'ram', 'radhe', 'good', 'morning', 'afternoon', 'evening', 'sir',
  'madam', 'mam', 'maam', 'there', 'team', 'thakar', 'kitchen', 'ji',
]);

// First match wins. Whole-word matching, so "hi" never matches "this".
const CATEGORY_KEYWORDS = [
  {
    category: 'bulk',
    keywords: ['bulk', 'wholesale', 'corporate', 'catering', 'distributor', 'dealer', 'reseller',
      'franchise', 'large order', 'gifting', 'party order', 'for a party', 'family function', 'event'],
  },
  {
    category: 'delivery_area',
    keywords: ['pincode', 'pin code', 'deliver to', 'deliver in', 'delivery to', 'delivery in',
      'ship to', 'shipping to', 'do you deliver', 'cash on delivery', 'cod', 'shipping charge',
      'shipping charges', 'delivery charge', 'delivery charges'],
  },
  {
    // Compliments. Skipped when the message asks something ("is it tasty?").
    category: 'praise',
    keywords: ['loved', 'love it', 'love the', 'love your', 'tasty', 'delicious', 'yummy', 'amazing',
      'awesome', 'superb', 'excellent', 'mast', 'badhiya', 'swadisht'],
  },
  {
    category: 'question',
    keywords: ['jain', 'onion', 'garlic', 'menu', 'ingredient', 'ingredients', 'vegan', 'gluten',
      'sugar', 'spicy', 'shelf life', 'how to cook', 'how to heat', 'heat', 'microwave', 'calories',
      'nutrition', 'protein', 'available', 'in stock', 'price', 'prices', 'cost', 'rate', 'kitna',
      'flavour', 'flavours', 'flavor', 'flavors', 'product', 'products', 'combo', 'discount',
      'coupon', 'offer', 'offers'],
  },
].map(({ category, keywords }) => ({
  category,
  patterns: keywords.map(
    (k) => new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u')
  ),
}));

const REPLIES = {
  greeting:
    'Hi, thanks for messaging Thakar Kitchen! How can we help you today? For an update on your order, just send "where is my order".',
  question: "Thanks for your question! We've received it and will get back to you with the details soon.",
  bulk:
    "Thanks for your interest in a bulk order! Please share the products, quantities and delivery city, and we'll get back to you with the details soon.",
  delivery_area: "Thanks for asking! Please share your pincode and we'll confirm delivery to your area soon.",
  praise: 'Thank you so much for the kind words! It really means a lot to us.',
  photo:
    "Thanks for the photo! If something is wrong with your order, please tell us in a line what happened and we'll look into it right away.",
  voice:
    "Thanks for your voice message! We'll get back to you soon. If it's about a problem with your order, a short text helps us act faster.",
  general: "Thanks for your message! We've received it and will get back to you soon.",
};

/**
 * Which acknowledgment fits this message, or null when none should be sent
 * (reactions, stickers, locations, "ok thanks", emoji-only...).
 */
function categorize(type, text) {
  if (type === 'image') return 'photo';
  if (type === 'audio') return 'voice';
  if (type === 'video' || type === 'document') return 'general';
  if (type !== 'text') return null;

  const normalized = String(text || '').toLowerCase().trim();
  const words = normalized.match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length === 0) return null; // emoji / punctuation only
  const bare = words.map((w) => w.replace(/'/g, ''));
  if (bare.length <= 4 && bare.every((w) => COURTESY_WORDS.has(w))) return null;
  if (bare.length <= 6 && bare.every((w) => GREETING_WORDS.has(w))) return 'greeting';

  const asksSomething = normalized.includes('?');
  for (const { category, patterns } of CATEGORY_KEYWORDS) {
    if (category === 'praise' && asksSomething) continue;
    if (patterns.some((re) => re.test(normalized))) return category;
  }
  return 'general';
}

function replyFor(category) {
  let reply = REPLIES[category] || REPLIES.general;
  if (category === 'question' && process.env.STORE_URL) {
    reply += ` Meanwhile, you can browse our menu here: ${process.env.STORE_URL}`;
  }
  return reply;
}

// How long before the same kind of acknowledgment may be sent to a customer
// again, and how long the app stays quiet after the founder has replied.
function cooldownHours() {
  return Number(process.env.ACK_COOLDOWN_HOURS || 12);
}

// Every acknowledgment category (for counting them on the Home screen).
const CATEGORIES = Object.keys(REPLIES);

module.exports = { categorize, replyFor, cooldownHours, CATEGORIES };
