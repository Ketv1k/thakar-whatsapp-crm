# Thakar Kitchen — WhatsApp CRM & Support System

A custom replacement for Zoko: WhatsApp messaging, auto order-status lookups,
and a separated support ticket system — built to plug into (or run alongside)
your existing Node/Express/MongoDB backend.

## What's in here

```
src/
  app.js              Express app (routes + auth) - mount this into your existing backend, or run standalone
  server.js           Standalone entry point (npm start) - connects DB, serves the PWA, starts the SLA job
  models/              Customer, Conversation, Message, Ticket (Mongoose)
  services/
    whatsapp.js        Send/receive via Meta's WhatsApp Cloud API (+ download customers' photos/voice notes)
    outbound.js         Every reply goes through here, so its delivery ticks can be tracked
    deliveryStatus.js   Sent / delivered / read / failed ticks from WhatsApp's status webhooks
    messageContent.js   Turns a WhatsApp message (text, photo, voice note, file...) into what the inbox shows
    replyWindow.js      WhatsApp's 24-hour free-reply window
    inboxView.js        The chat list (search, filters), one chat, and the Home dashboard numbers
    founderReply.js     Your reply from the inbox (moves the ticket to "You replied")
    shopify.js          Look up a customer's latest order by phone (Shopify Admin GraphQL)
    ticketTriage.js     The keyword logic that decides: auto-answer / create ticket / leave as general chat
  routes/
    webhook.js          Receives WhatsApp messages and delivery ticks, runs triage
    inbox.js             Home dashboard, the one inbox, replies, media, "flag as ticket" escape hatch
    tickets.js            Ticket list + reply + resolve
  jobs/slaCheck.js      Hourly cron: pings you on WhatsApp if a ticket's been open 6+ hours
public/                 Founder Inbox - mobile-first PWA (installable, "Add to Home Screen")
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

## Test mode (try it before WhatsApp is connected)

Set `TEST_MODE=true` and:
- the inbox shows a "Test mode" label and a **Test** page;
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
- **Marketing opt-in** — toggle that will feed Phase 2 broadcasts.

API: `GET /api/customers/:phone` returns the assembled profile; `PATCH /api/customers/:phone`
updates the note / tags / opt-in. Both require the Inbox API key.

## Not built yet (Phase 2 / 3, per our plan)
- Marketing broadcasts to a customer segment
- Abandoned cart recovery
- Product catalog

Both slot into the same structure - a new route + a template + a trigger in `jobs/` - once Phase 1 is
live and your message templates are approved.
