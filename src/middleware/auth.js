// Minimal shared-secret auth for the Inbox API.
// The PWA sends: Authorization: Bearer <INBOX_API_KEY>
// This is intentionally simple for a single-founder operation. If you later add
// staff/agents, swap this for proper per-user JWT auth (you've already got that
// pattern in your existing backend).
const crypto = require('crypto');

// Length-safe, constant-time string compare so we don't leak the key one byte
// at a time via response timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireInboxAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!process.env.INBOX_API_KEY) {
    return res.status(500).json({ error: 'INBOX_API_KEY is not configured on the server' });
  }
  if (!token || !safeEqual(token, process.env.INBOX_API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireInboxAuth };
