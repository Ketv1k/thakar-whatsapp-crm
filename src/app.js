// Exports a ready-to-use Express app.
//
// Two ways to run this:
//   1. Standalone (this repo on its own): `npm start` -> see server.js
//   2. Mounted into your existing backend: in your existing app.js,
//        const whatsappCrm = require('./thakar-whatsapp-crm/src/app');
//        app.use(whatsappCrm);
//      ...as long as your existing app already calls express.json() and
//      connects to the same MongoDB, everything here works as-is - just
//      copy the src/models files into your models folder (or point
//      require() at this folder) and make sure the env vars in
//      .env.example are set on your existing server.
const express = require('express');
const cors = require('cors');

const webhookRoutes = require('./routes/webhook');
const inboxRoutes = require('./routes/inbox');
const ticketRoutes = require('./routes/tickets');
const { requireInboxAuth } = require('./middleware/auth');

const app = express();

app.use(cors());
app.use(express.json());

// Meta calls this directly - no auth header, verified via WHATSAPP_VERIFY_TOKEN instead.
app.use('/webhook', webhookRoutes);

// Everything the Founder Inbox PWA calls - protected by the shared INBOX_API_KEY.
app.use('/api', requireInboxAuth, inboxRoutes);
app.use('/api/tickets', requireInboxAuth, ticketRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

module.exports = app;
