// Exports a ready-to-use Express app.
//
// Two ways to run this:
//   1. Standalone (this repo on its own): `npm start` -> see server.js
//   2. Mounted into your existing backend: in your existing app.js,
//        const whatsappCrm = require('./thakar-whatsapp-crm/src/app');
//        app.use(whatsappCrm);
//      ...as long as your existing app connects to the same MongoDB and the
//      env vars in .env.example are set, everything here works as-is - just
//      copy the src/models files into your models folder (or point require()
//      at this folder). Note: don't run a global express.json() before this
//      app's routes, or the webhook can't see the raw body it needs to verify
//      Meta's signature - let the parsers below handle body parsing instead.
const express = require('express');
const cors = require('cors');

const webhookRoutes = require('./routes/webhook');
const inboxRoutes = require('./routes/inbox');
const ticketRoutes = require('./routes/tickets');
const customerRoutes = require('./routes/customers');
const automationRoutes = require('./routes/automations');
const templateRoutes = require('./routes/templates');
const campaignRoutes = require('./routes/campaigns');
const shopRoutes = require('./routes/shop');
const teamRoutes = require('./routes/team');
const { requireInboxAuth, ownerForChanges } = require('./middleware/auth');
const { verifyWhatsAppSignature } = require('./middleware/verifyWhatsAppSignature');

const app = express();

app.use(cors());

// Keep the exact bytes Meta hashed so we can verify X-Hub-Signature-256.
function captureRawBody(req, res, buf) {
  req.rawBody = buf;
}

// Body parsers are scoped per route group (rather than one global parser) so the
// webhook parser can capture the raw body for signature verification, and so a
// huge payload is rejected before it reaches a handler.
const webhookJson = express.json({ limit: '1mb', verify: captureRawBody });
const apiJson = express.json({ limit: '1mb' });

// Shopify calls this the moment orders, customers, carts or stock change.
// Authenticity is proven by Shopify's signature (services/shopifyLive.js).
app.post('/shopify/webhooks', express.raw({ type: '*/*', limit: '2mb' }), (req, res, next) =>
  require('./services/shopifyLive').receive(req, res).catch(next)
);

// Meta calls this directly - no auth header; authenticity is proven by the
// signature check (WHATSAPP_APP_SECRET) and the GET verify token instead.
app.use('/webhook', webhookJson, verifyWhatsAppSignature, webhookRoutes);

// Everything the Founder Inbox PWA calls - protected by the shared INBOX_API_KEY.
// (A customer list import carries a whole CSV file, so it gets more room.)
app.use('/api/customers/import', requireInboxAuth, express.json({ limit: '8mb' }));
// Logging in needs no token (and has its own limit on wrong tries).
app.post('/api/login', apiJson, teamRoutes.login);
app.use('/api', apiJson, requireInboxAuth, teamRoutes.router);
app.use('/api', apiJson, requireInboxAuth, inboxRoutes);
app.use('/api/tickets', apiJson, requireInboxAuth, ticketRoutes);
app.use('/api/customers', apiJson, requireInboxAuth, customerRoutes);
// Team members can see these; only the owner can change them.
app.use('/api/automations', apiJson, requireInboxAuth, ownerForChanges, automationRoutes);
app.use('/api/templates', apiJson, requireInboxAuth, ownerForChanges, templateRoutes);
app.use('/api/campaigns', apiJson, requireInboxAuth, ownerForChanges, campaignRoutes);
app.use('/api', apiJson, requireInboxAuth, shopRoutes);

// Customer-message simulator; only exists while TEST_MODE=true.
if (process.env.TEST_MODE === 'true') {
  app.use('/api/test', apiJson, requireInboxAuth, require('./routes/testMode'));
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Central error handler. Keeps the API from crashing/hanging on bad input and
// avoids leaking stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Malformed JSON body.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  // Payload over the size limit.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  // A deliberate, user-facing error (e.g. the reply window has closed).
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  // Bad Mongo ObjectId in a :id param, or a schema validation failure.
  if (err.name === 'CastError' || err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  console.error('[app] unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
