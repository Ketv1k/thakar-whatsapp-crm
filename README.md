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
    whatsapp.js        Send/receive via Meta's WhatsApp Cloud API
    shopify.js          Look up a customer's latest order by phone (Shopify Admin GraphQL)
    ticketTriage.js     The keyword logic that decides: auto-answer / create ticket / leave as general chat
  routes/
    webhook.js          Receives WhatsApp messages, runs triage
    inbox.js             General chat list + reply + "flag as ticket" escape hatch
    tickets.js            Ticket list + reply + resolve
  jobs/slaCheck.js      Hourly cron: pings you on WhatsApp if a ticket's been open 6+ hours
public/                 Founder Inbox - mobile-first PWA (installable, "Add to Home Screen")
```

## How the support flow works

1. Customer messages in on WhatsApp.
2. If it's a plain "where's my order" question → auto-answered from Shopify. No ticket, no work for you.
3. If it's a real issue (damaged, wrong item, missing, delay complaint, refund ask) → pulled into a
   **ticket**, separated from general chat, customer gets an instant acknowledgment with a ticket number.
4. Anything else → sits in the normal Chats tab for you to answer.
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

### 3. Get your Shopify Admin API token
Shopify Admin → Settings → Apps and sales channels → Develop apps → Create an app →
give it `read_customers` and `read_orders` scopes → install it → copy the Admin API access token.

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

## Customer profiles (CRM)

Tap the person icon in any conversation to see a customer's full profile, assembled
automatically — no manual data entry:

- **Automatic status** — New / Returning / VIP, worked out from their Shopify order
  history (tune the thresholds via `CRM_RETURNING_ORDERS`, `CRM_VIP_ORDERS`,
  `CRM_VIP_SPEND`).
- **Order history + lifetime spend** — pulled live from Shopify.
- **Past tickets** — every support issue this customer has raised.
- **Private note** — the one thing you type: allergies, delivery preferences, "buys in
  bulk", etc.
- **Marketing opt-in** — toggle that will feed Phase 2 broadcasts.

API: `GET /api/customers/:phone` returns the assembled profile; `PATCH /api/customers/:phone`
updates the note / opt-in. Both require the Inbox API key.

## Not built yet (Phase 2 / 3, per our plan)
- Marketing broadcasts to a customer segment
- Abandoned cart recovery
- Product catalog

Both slot into the same structure - a new route + a template + a trigger in `jobs/` - once Phase 1 is
live and your message templates are approved.
