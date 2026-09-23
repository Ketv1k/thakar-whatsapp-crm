# Thakar Kitchen — WhatsApp CRM & Support System

A custom replacement for Zoko: WhatsApp messaging, auto order-status lookups,
and a separated support ticket system — built to plug into (or run alongside)
your existing Node/Express/MongoDB backend.

## What's in here

```
src/
  app.js              Express app (routes + auth) - mount this into your existing backend, or run standalone
  server.js           Standalone entry point (npm start) - connects DB, serves the PWA, starts the jobs
  models/              Customer, Conversation, Message, Ticket, Order, AbandonedCheckout, StockAlert,
                       Template, Campaign, Setting (Mongoose)
  services/
    whatsapp.js        Send/receive via Meta's WhatsApp Cloud API (+ download customers' photos/voice notes)
    outbound.js         Every message the app sends goes through here (text + templates), with delivery tracking
    templates.js        WhatsApp message templates: built-in ones, rendering, sending, Meta approval
    deliveryStatus.js   Sent / delivered / read / failed ticks from WhatsApp's status webhooks
    messageContent.js   Turns a WhatsApp message (text, photo, voice note, file...) into what the inbox shows
    replyWindow.js      WhatsApp's 24-hour free-reply window
    inboxView.js        The chat list (search, filters), one chat, and the Home dashboard numbers
    founderReply.js     Your reply from the inbox (moves the ticket to "You replied")
    automations.js      On/off switches and settings for the automatic messages
    orderSync.js        Shopify orders -> order updates (confirmed, shipped, delivered...)
    orderEvents.js      The rules for which order update is due (pure, tested)
    cod.js              COD confirmation: Confirm / Cancel buttons and the answers
    customerSync.js     Shopify customers -> the CRM (orders, spend, city, marketing consent)
    segments.js         Customer groups (VIP, lapsed, opted in...)
    campaigns.js        Broadcasts: audience, cost, sending, results
    cartRecovery.js     Abandoned-cart reminders
    reorder.js          Reorder reminders
    backInStock.js      Back-in-stock alerts
    optIn.js            STOP / START and marketing opt-in
    pricing.js          What WhatsApp messages cost (for the estimates in the app)
    shopify.js          Shopify Admin GraphQL (orders, customers, products, tags)
    ticketTriage.js     The keyword logic that decides: auto-answer / create ticket / leave as general chat
  routes/
    webhook.js          Receives WhatsApp messages, button taps and delivery ticks; runs triage
    inbox.js             Home dashboard, the one inbox, replies, media, "flag as ticket" escape hatch
    tickets.js            Ticket list + reply + resolve
    customers.js          Customer directory, groups, profiles, bulk opt-in
    automations.js        Automation switches, stats, "check now"
    campaigns.js          Campaign drafts, estimates, scheduling, results
    templates.js          Message templates: list, create, submit to Meta, refresh
    shop.js               COD orders, product search, back-in-stock requests
    testMode.js           Test-mode simulators (messages, orders, COD taps, carts, reorders, restocks)
  jobs/
    scheduler.js        Background jobs: order/customer/cart sync, reminders, campaigns
    slaCheck.js         Hourly: pings you on WhatsApp if a ticket's been open 6+ hours
public/                 Founder Inbox - installable web app (no build step; ES modules in public/js/)
```

## How the support flow works

1. Customer messages in on WhatsApp.
2. If it's a plain "where's my order" question → auto-answered from Shopify. No ticket, no work for you.
3. If it's a real issue (damaged, wrong item, missing, delay complaint, refund ask, food quality
   complaint, payment problem) → pulled into a **ticket**, separated from general chat, customer gets an
   instant acknowledgment with a ticket number (plus a photo or transaction-reference request where it helps).
4. Anything else → the customer gets an instant acknowledgment that fits what they sent
   (greeting, product question, bulk order, delivery area, compliment, photo, voice note, or a
   general "we've received it"), and the message waits in the Inbox (marked "Needs reply") for you. "ok"/"thanks",
   emoji-only messages, reactions and stickers get no reply; the same kind of acknowledgment isn't
   repeated within `ACK_COOLDOWN_HOURS`, and none are sent while you're talking to that customer.
   Wording and keywords live in `src/services/autoAck.js`.
5. A ticket unresolved for 6+ hours pings you directly on WhatsApp so nothing gets missed.
6. You can also manually flag any chat as a ticket from the app, as a safety net for anything the
   keyword matching misses.

## Setup

### 1. Install dependencies
```
npm install
```

### 2. Get your WhatsApp Cloud API credentials
1. Go to [developers.facebook.com](https://developers.facebook.com) → create an app → add the "WhatsApp" product.
2. Under **API Setup** you'll get a temporary token + a test phone number to start with. For production,
   generate a **permanent** access token (System User, in Business Settings) and add your real number.
   - Note: if your number is currently active with Zoko, it's almost certainly already on the WhatsApp
     Business Platform (not the free consumer app) - check Zoko's dashboard / your Meta Business Manager
     before doing anything, so you migrate it to your own app rather than re-registering from scratch.
3. Under **Configuration**, set your webhook URL to `https://<your-domain>/webhook` and the verify token
   to whatever you put in `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.
4. Copy your **App Secret** (Settings → Basic) into `WHATSAPP_APP_SECRET`. The webhook uses it to verify
   Meta's `X-Hub-Signature-256` on every incoming POST and reject forged requests. If you leave it blank
   the server still runs but logs a warning and accepts unauthenticated webhooks — set it before going live.

### 3. Connect Shopify
Either of these works — pick one:

- **Dev Dashboard app (recommended):** at [dev.shopify.com](https://dev.shopify.com), create an app,
  release a version with read scopes for orders, customers and products, and install it on your store.
  Copy its **Client ID** and **Client secret** into `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`.
  The server exchanges them for an access token and renews it automatically every 24 hours.
  (The app and store must belong to the same Shopify organization.)
- **Store-admin custom app:** Shopify Admin → Settings → Apps and sales channels → Develop apps →
  Create an app → add `read_customers` and `read_orders` scopes → install → copy the permanent
  Admin API access token (`shpat_…`) into `SHOPIFY_ADMIN_API_TOKEN`.

### 4. Configure environment
```
cp .env.example .env
# fill in MONGODB_URI, WHATSAPP_*, SHOPIFY_*, FOUNDER_PHONE, INBOX_API_KEY
```
`INBOX_API_KEY` is a password you make up yourself - it's what the mobile inbox uses to log in.

### 5. Run it

**Standalone** (this repo on its own server/host):
```
npm start
```
Then open `https://<your-domain>/` on your phone and "Add to Home Screen" for the installable app.

**Mounted into your existing backend** (recommended per our plan - one thing to host, not two):
```js
// in your existing app.js
const whatsappCrm = require('./thakar-whatsapp-crm/src/app');
app.use(whatsappCrm);
```
Copy this project's `src/models/*` into wherever your existing models live (or just require them from
here), make sure your existing app connects to the same MongoDB, serve `public/` as static files, and
call `require('./thakar-whatsapp-crm/src/jobs/slaCheck').startSlaCheckJob()` once at startup. Mount this
app *before* any global `express.json()` in your existing backend (see the note under "Production
hardening" below) so the webhook can verify Meta's signature.

### 6. Local testing before going live
WhatsApp needs a public HTTPS URL to send webhooks to. For local testing, use `ngrok http 3000` and put
that URL (+ `/webhook`) into Meta's webhook config temporarily.

Run the unit tests (triage rules + webhook signature verification) with:
```
npm test
```

## AI answers from your website info (bring your own model)

General questions (delivery charges, stores, heating, storage, products, prices, payments,
cancellations...) can get a real answer instead of an acknowledgment. The AI only uses:
- `src/knowledge/thakar-kitchen.md` - FAQs, policies, stores and contact details from
  thakarkitchen.com. **Edit this file** to change what it knows (e.g. add a temporary notice
  under "Current notices"), then redeploy.
- your live Shopify product list with prices and stock, refreshed daily.

If the answer isn't there, it doesn't guess: the customer gets the normal acknowledgment and the
message waits in Chats for you. Order status and problems keep their own flows (Shopify lookup,
tickets). It stays quiet in conversations you're personally handling, and AI replies are labelled
"Auto-reply" in the inbox. If the AI provider fails, the acknowledgment is sent instead.

Choose any model with environment variables (no key = AI answers off):

| Setting | Claude | Any OpenAI-compatible provider |
|---|---|---|
| `AI_PROVIDER` | `anthropic` | `openai` |
| `AI_MODEL` | `claude-opus-5` (default), `claude-sonnet-5`, `claude-haiku-4-5` | the provider's model name |
| `AI_API_KEY` | from console.anthropic.com | the provider's key |
| `AI_BASE_URL` | leave empty | e.g. `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`, `https://api.deepseek.com/v1` |

If a provider doesn't support OpenAI's JSON mode, the app asks again without it (the
instructions already ask for JSON), so any OpenAI-compatible provider works.

**What it costs.** Each answer sends about 3,500 tokens (the knowledge file plus ~47 products) and
gets about 200 back. Approximate cost per answer, prices as of September 2026:

| Model | Settings | Price per million tokens (in / out) | Per answer |
|---|---|---|---|
| Gemini 3.1 Flash-Lite | `openai`, `gemini-3.1-flash-lite`, Gemini base URL | $0.25 / $1.50 | ≈ ₹0.10 |
| DeepSeek Flash | `openai`, `deepseek-flash`, DeepSeek base URL | $0.30 / $1.20 (half off-peak) | ≈ ₹0.05–0.11 |
| Claude Haiku 4.5 | `anthropic`, `claude-haiku-4-5` | $1 / $5 | ≈ ₹0.40 |
| Claude Sonnet 5 | `anthropic`, `claude-sonnet-5` | $2 / $10 | ≈ ₹1 |
| Claude Opus 5 | `anthropic`, `claude-opus-5` | $5 / $25 | ≈ ₹2.50 |

Customer messages are personal data: use a paid (billing-enabled) account, since free tiers may
use prompts to improve the provider's models. Jev (TypeSafe) can't be used here - it classifies
and scores but can't write text.

## Test mode (try it before WhatsApp is connected)

Set `TEST_MODE=true` and:
- the inbox shows a "Test mode" label and a **Test** page, where you can also place pretend
  orders (prepaid or COD), tap the customer's Confirm / Cancel, ship and deliver them, leave a
  cart, and trigger reorder and back-in-stock messages - all through the real automation code;
- on the Test page you pick one of your real Shopify customers (or type any number), choose or
  type their message (or send a photo / voice note), and see exactly what happens:
  auto-answered from Shopify, a ticket created, or waiting in the Inbox, plus the reply the
  customer *would* receive. Test photos and voice notes show a stand-in picture and a short tune.
  When a test customer writes back, your earlier replies get blue "read" ticks, as on WhatsApp;
- **nothing is ever sent on WhatsApp**: every outgoing message is saved and logged
  (`[test mode] not sent to …`) instead.

Turn it off (`TEST_MODE=false` or remove it) once WhatsApp is connected.

## Deploy on Render

`render.yaml` is a Render Blueprint. In Render: **New → Blueprint** → pick this repo → paste the
secret values it asks for (`INBOX_API_KEY`, `MONGODB_URI`, `SHOPIFY_CLIENT_ID`,
`SHOPIFY_CLIENT_SECRET`) → **Apply**. It starts on the free plan in test mode; switch the plan to
Starter and remove `TEST_MODE` when going live with WhatsApp.

## Production hardening (built in)
- **Webhook authenticity** — every `POST /webhook` is checked against Meta's `X-Hub-Signature-256`
  using `WHATSAPP_APP_SECRET` (fails closed when the secret is set). The `GET` handshake still uses
  `WHATSAPP_VERIFY_TOKEN`.
- **Duplicate deliveries** — Meta retries webhooks, so inbound messages are de-duplicated on the
  WhatsApp message id (unique index + pre-check). A retried message won't double-reply or open a
  second ticket.
- **Ticket numbers** — handed out via an atomic counter, so two messages arriving at once can't collide.
- **Robust API** — async routes can't crash the process on bad input; a malformed `:id`, oversized
  body, or bad JSON returns a clean 4xx instead of a stack trace. The Inbox API key is compared in
  constant time.

> **Mounting into an existing backend:** the webhook needs the *raw* request body to verify Meta's
> signature. Don't run a global `express.json()` ahead of these routes — let this app's own scoped
> parsers handle body parsing (they capture the raw bytes for you).

## The inbox

- **Home** — today at a glance: open tickets (and which are overdue), chats waiting for a
  reply, how many were answered for you automatically, and a "Needs your attention" list with
  the most urgent first.
- **Inbox** — one list with every customer, newest first. Search by name, part of a number,
  tag or ticket number (`#1042`); filter to **Needs reply** or **Tickets**. A ticket is a label
  on the customer's chat, not a separate list.
- **Chats** show photos (tap to enlarge), play voice notes, offer files as downloads, and show
  WhatsApp ticks on your replies: one grey tick sent, two grey delivered, two blue read (or
  "Not delivered" with WhatsApp's reason).
- **Reply window** — WhatsApp only allows free-form replies for 24 hours after the customer's
  last message. Every chat shows how long is left; once it closes the reply box explains why
  it's locked instead of failing.
- On a computer the list, chat and customer sit side by side (like WhatsApp Web); on a phone
  it's one screen at a time with tabs at the bottom. `FOUNDER_NAME` sets the name in the
  greeting.

## Customer profiles (CRM)

Next to each chat (or via the person icon on a phone) is the customer's profile, assembled
automatically — no manual data entry:

- **Automatic status** — New / Returning / VIP, worked out from their Shopify order
  history (tune the thresholds via `CRM_RETURNING_ORDERS`, `CRM_VIP_ORDERS`,
  `CRM_VIP_SPEND`).
- **Order history + lifetime spend** — pulled live from Shopify.
- **Past tickets** — every support issue this customer has raised.
- **Tags** — your own labels ("Jain", "Monthly", "Gifting"); searchable from the inbox.
- **Private note** — allergies, delivery preferences, "buys in bulk", etc.
- **Orders with COD answers**, and **back-in-stock requests** for this customer.
- **Offers opt-in** — whether they get campaigns and reminders, and how they opted in.

API: `GET /api/customers/:phone` returns the assembled profile; `PATCH /api/customers/:phone`
updates the note / tags / opt-in. Both require the Inbox API key.

## Order updates and COD confirmation

Switch these on in **Automations**. Every few minutes the app asks Shopify for orders changed
since its last check (so it catches up after the server slept) and sends:

- **Order confirmed** — when an order is placed.
- **COD confirmation** — instead of "confirmed" for cash-on-delivery orders (the plain COD
  gateway, and Razorpay Magic "partial COD" orders tagged `razorpay_partial_cod`, where ₹99 is
  paid online). The message shows the amount to pay on delivery and has **Confirm order** /
  **Cancel order** buttons. The answer is tagged on the order in Shopify (`COD confirmed on
  WhatsApp` / `COD cancel requested on WhatsApp`); cancel requests show on Home and on the **COD
  orders** page so you can cancel them in Shopify. You can also mark answers yourself.
- **Shipped** — with the tracking link (India Post) or the order status page.
- **Out for delivery / Delivered** — only if your courier updates delivery status in Shopify.

Safety: each update is sent at most once (claimed in the database first); an automation only acts
on things that happen after you switch it on; updates that are too old to be useful are dropped;
if several are due at once only the newest goes. These are *utility* templates: about ₹0.14 each
incl. GST, free if the customer messaged you in the last 24 hours.

## Customers, groups and campaigns

- **Customers** — every Shopify customer with a phone number (synced every 6 hours) plus everyone
  who has messaged, with orders, spend, last order, city, tags and whether they get offers.
  Groups: VIP, Returning, Ordered once, Lapsed 45+ days (`CRM_LAPSED_DAYS`), No orders yet,
  Opted in to offers — plus any tag.
- **Campaigns** — pick a group, an approved message and a time. The composer shows how many
  people it reaches and what it costs (Meta's marketing rate, ₹0.8631 + 18% GST ≈ ₹1.02 each),
  and a preview. "Send a test to me" goes to `FOUNDER_PHONE`. Results: sent, delivered, read,
  replies within 3 days, and orders + revenue within 7 days.
- New campaign messages can be written in the app ("Write a new one"); they get a **Stop
  promotions** button and go to Meta for approval. Photo messages can be made in WhatsApp Manager
  and are imported by **Refresh** on the Automations page.
- Campaigns only go to customers who **opted in to offers**, and skip anyone who got an offer in
  the last `CAMPAIGN_MIN_GAP_HOURS` (24). Each person gets a campaign once, even if sending is
  interrupted. Sending stops by itself if WhatsApp keeps refusing.

### Who gets offers (opt-in)

WhatsApp only allows marketing to people who agreed to it. A customer is opted in when:
you switch it on in their profile; they reply **START**; you opt in a whole group on the
Customers page (only if they already agreed elsewhere, e.g. in Zoko); or — if you turn it on in
Automations — they accepted marketing at checkout in Shopify. Replying **STOP** (or tapping
**Stop promotions**) opts them out; order updates still reach them.

## Cart, reorder and back-in-stock reminders

- **Abandoned cart** — one reminder 30 min to 6 hours after someone leaves checkout (your
  choice); not if they ordered meanwhile, not twice a day. Orders placed within 3 days count as
  recovered. Built for **Razorpay Magic Checkout**: Magic records its own recovery link on the
  Shopify abandoned checkout (`magic_checkout_url` → `/cart?magic_order_id=…`), which reopens the
  order in Magic Checkout; the app sends that link on the shop's own domain. Without it, the link
  opens the cart page with the same products (`/cart/<variant>:<qty>,…?storefront=true`), where the
  Checkout button opens Magic as usual. It goes to customers who said yes to WhatsApp messages in
  Magic Checkout (`checkout_whatsapp_consent`) or opted in to offers; a "no" at checkout or a STOP
  always wins, and Magic's contact number is used when the cart has no other phone.
- **Reorder reminders** — 14/21/30/45 days after an order ships, naming what they bought; skipped
  if they ordered again; at most one a month per customer.
- **Back-in-stock** — on a customer's profile, search a product (or a sold-out size) they asked
  about; every half hour the app checks Shopify and messages everyone waiting once it's back.

All three are marketing messages: opted-in customers only (cart reminders also accept the
consent given at checkout; back-in-stock needs only the customer's own request), never at night
(`QUIET_HOURS`, default 9pm–9am India time).

## Going live checklist

1. Connect WhatsApp (the `WHATSAPP_*` settings) and set `WHATSAPP_BUSINESS_ACCOUNT_ID`.
2. Remove `TEST_MODE` (or set it to `false`).
3. Automations → **Submit all to Meta**. Approval usually takes minutes to a day; **Refresh**
   shows the status. Nothing that needs a template is sent until it's approved.
4. Switch on the automations you want. Decide who gets offers (see above).
5. On Render, switch to a paid plan so the background jobs run all the time.

## Ideas for later
- Product catalog messages
- Several team members with their own logins
