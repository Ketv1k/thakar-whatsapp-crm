require('dotenv').config();
const path = require('path');
const express = require('express');
const app = require('./app');
const { connectDB } = require('./config/db');
const { startSlaCheckJob } = require('./jobs/slaCheck');

// Serve the Founder Inbox PWA (public/) at the site root.
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();
  startSlaCheckJob();
  app.listen(PORT, () => {
    console.log(`[server] Thakar WhatsApp CRM listening on port ${PORT}`);
    if (process.env.TEST_MODE === 'true') {
      console.log('[server] TEST MODE is on: WhatsApp messages are logged, not sent');
    }
  });
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
