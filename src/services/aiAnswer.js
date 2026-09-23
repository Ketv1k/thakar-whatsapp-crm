// AI answers to general customer questions, strictly from the shop's own
// information: src/knowledge/thakar-kitchen.md plus the live Shopify product
// list (refreshed daily).
//
// Bring your own model - set in the environment:
//   AI_PROVIDER  "anthropic" (Claude, via Anthropic's SDK) or "openai" (any
//                OpenAI-compatible API: OpenAI, Gemini, DeepSeek, Groq, OpenRouter...)
//   AI_API_KEY   the provider's API key (no key = AI answers are off)
//   AI_MODEL     e.g. claude-opus-5, gpt-..., gemini-... (Claude defaults to claude-opus-5)
//   AI_BASE_URL  the provider's API address (required for "openai")
//
// Anything the knowledge doesn't cover comes back as not answered, and any
// failure returns null - the caller then sends the plain acknowledgment, so a
// customer is never left without a reply.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const shopify = require('./shopify');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'knowledge', 'thakar-kitchen.md');
const PRODUCTS_TTL_MS = 24 * 60 * 60 * 1000;
const PRODUCTS_RETRY_MS = 60 * 60 * 1000;
const MAX_REPLY_CHARS = 3000; // WhatsApp's limit is 4096

const INSTRUCTIONS = `You reply to WhatsApp messages sent to Thakar Kitchen, a family-run Indian ready-to-eat food brand, on the founder's behalf. Your reply is sent to the customer immediately and automatically.

Answer only from the information inside <knowledge>. Customers write in English, Hinglish, Hindi or Gujarati; reply in the same language and script they used.

Set "answered" to true and write "reply" only when the knowledge fully answers the message. Otherwise set "answered" to false and leave "reply" empty, and the founder will reply personally. That includes anything the knowledge doesn't cover (never guess prices, dates, stock, ingredients or store locations), the status of a specific order, bulk, wholesale or custom requests, complaints, and anything you are unsure about.

When you answer, write like a friendly shop assistant on WhatsApp: at most three or four short sentences, or a short list when listing products or stores. No headings, tables or markdown links; use *single asterisks* for bold if needed. Say when a product is sold out. Don't promise anything the knowledge doesn't say - no discounts, delivery dates or refunds beyond the policy. Skip long greetings and sign-offs.

Respond only with a JSON object of the form {"answered": boolean, "reply": string}.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answered: { type: 'boolean' },
    reply: { type: 'string' },
  },
  required: ['answered', 'reply'],
  additionalProperties: false,
};

// Server-side refusal fallback is offered on these Claude models.
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);
// Models that accept output_config.effort (Haiku 4.5 and older Claude models don't).
const EFFORT_MODEL_RE = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable-5)/;

function config() {
  const provider = (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase();
  return {
    provider,
    apiKey: (process.env.AI_API_KEY || '').trim(),
    model: (process.env.AI_MODEL || (provider === 'anthropic' ? 'claude-opus-5' : '')).trim(),
    baseUrl: (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, ''),
  };
}

function isConfigured() {
  const c = config();
  if (!c.apiKey || !c.model) return false;
  if (c.provider === 'anthropic') return true;
  if (c.provider === 'openai') return !!c.baseUrl;
  return false;
}

// What the inbox shows about AI answers (never includes the key).
function status() {
  const c = config();
  return { enabled: isConfigured(), provider: c.provider, model: c.model || null };
}

// ---------- Knowledge ----------
let knowledgeText = null;
let productsCache = { text: '', fetchedAt: 0 };

// Descriptions repeat the same boilerplate; keep only what differs per product.
function cleanDescription(description) {
  return String(description || '')
    .replace(/Ready To Eat .*? by Thakar Kitchen\.?/i, '')
    .replace(/Made with 100% Groundnut Oil\.?/i, '')
    .replace(/No Preservatives\.?/i, '')
    .replace(/No Added Colou?rs\.?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatProducts(products, date) {
  if (!products.length) return '';
  const lines = products.map((p) => {
    const variants = p.variants || [];
    const soldOut = variants.length > 0 && variants.every((v) => !v.availableForSale);
    const prices = variants
      .map((v) => {
        const label = v.title && v.title !== 'Default Title' ? `${v.title} ` : '';
        return `${label}₹${Number(v.price)}${!soldOut && !v.availableForSale ? ' (sold out)' : ''}`;
      })
      .join(', ');
    const details = cleanDescription(p.description);
    const category = p.productType ? ` (${p.productType})` : '';
    return `- ${p.title}${category}: ${soldOut ? 'currently SOLD OUT. ' : ''}${prices}.${details ? ` ${details}` : ''}`;
  });
  const day = date.toISOString().slice(0, 10);
  return `## Products and prices (from the online shop, updated ${day})\n${lines.join('\n')}`;
}

async function productsSection() {
  if (productsCache.text && Date.now() - productsCache.fetchedAt < PRODUCTS_TTL_MS) {
    return productsCache.text;
  }
  if (!productsCache.text && Date.now() - productsCache.fetchedAt < PRODUCTS_RETRY_MS) return '';
  try {
    const products = await shopify.listProductsForKnowledge();
    productsCache = { text: formatProducts(products, new Date()), fetchedAt: Date.now() };
  } catch (err) {
    console.error('[ai] could not refresh products from Shopify:', err.message);
    // Keep the last good list; try again in an hour rather than on every message.
    productsCache.fetchedAt = Date.now() - (productsCache.text ? PRODUCTS_TTL_MS - PRODUCTS_RETRY_MS : 0);
  }
  return productsCache.text;
}

// Stable for a day at a time, so the provider can cache it between questions.
async function buildSystemText() {
  if (knowledgeText === null) knowledgeText = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
  const products = await productsSection();
  return `${INSTRUCTIONS}\n\n<knowledge>\n${knowledgeText}\n${products}\n</knowledge>`;
}

function buildUserText(message, history = []) {
  const lines = history
    .filter((m) => m.body)
    .map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Thakar Kitchen'}: ${m.body}`);
  const context = lines.length ? `Recent conversation, oldest first:\n${lines.join('\n')}\n\n` : '';
  return `${context}New message from the customer:\n${message}`;
}

// ---------- Providers ----------
async function askClaude(c, system, user) {
  const client = new Anthropic({
    apiKey: c.apiKey,
    baseURL: c.baseUrl || undefined,
    timeout: 30 * 1000,
    maxRetries: 1,
  });
  const params = {
    model: c.model,
    max_tokens: 4000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: {
      format: { type: 'json_schema', schema: ANSWER_SCHEMA },
      ...(EFFORT_MODEL_RE.test(c.model) ? { effort: 'low' } : {}),
    },
  };
  // If the model's safety classifier declines, the server retries on the
  // model Anthropic recommends instead of returning a refusal.
  const response = SERVER_FALLBACK_MODELS.has(c.model)
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return '';
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function askOpenAiCompatible(c, system, user) {
  const body = {
    model: c.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  };
  const send = (b) =>
    axios.post(`${c.baseUrl}/chat/completions`, b, {
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30 * 1000,
    });
  let res;
  try {
    res = await send(body);
  } catch (err) {
    // Not every provider or model supports JSON mode. The instructions already
    // ask for JSON and parseAnswer tolerates text around it, so ask once more
    // without it rather than giving up.
    const status = err.response && err.response.status;
    if (status !== 400 && status !== 422) throw err;
    const { response_format: _dropped, ...plain } = body;
    res = await send(plain);
  }
  return res.data?.choices?.[0]?.message?.content || '';
}

// Tolerates code fences or stray text around the JSON object.
function parseAnswer(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  if (parsed.answered !== true || !reply || reply.length > MAX_REPLY_CHARS) {
    return { answered: false, reply: '' };
  }
  return { answered: true, reply };
}

function errorDetail(err) {
  if (err instanceof Anthropic.APIError) return `${err.status ?? ''} ${err.message}`.trim();
  if (err.response) return `${err.response.status} ${JSON.stringify(err.response.data).slice(0, 300)}`;
  return err.message;
}

/**
 * Tries to answer a customer's message from the shop's information.
 * Returns { answered, reply }, or null when AI is off or the request failed.
 */
async function answer(message, history = []) {
  if (!isConfigured()) return null;
  const c = config();
  try {
    const system = await buildSystemText();
    const user = buildUserText(message, history);
    const raw =
      c.provider === 'anthropic' ? await askClaude(c, system, user) : await askOpenAiCompatible(c, system, user);
    return parseAnswer(raw);
  } catch (err) {
    console.error(`[ai] ${c.provider} request failed:`, errorDetail(err));
    return null;
  }
}

module.exports = { answer, isConfigured, status, parseAnswer, formatProducts, buildUserText, cleanDescription };
