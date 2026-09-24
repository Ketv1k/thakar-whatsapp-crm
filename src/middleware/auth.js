// Who is calling the Inbox API. The app sends: Authorization: Bearer <token>
//  - the access code (INBOX_API_KEY) logs in as the owner;
//  - a team login's session token logs in as that person.
// req.user is { _id, name, email, role: 'owner' | 'team' }.
const crypto = require('crypto');
const users = require('../services/users');

// Length-safe, constant-time string compare so we don't leak the key one byte
// at a time via response timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function requireInboxAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    if (process.env.INBOX_API_KEY && safeEqual(token, process.env.INBOX_API_KEY)) {
      req.user = users.codeOwner();
      return next();
    }
    const user = token.length >= 20 && token.length <= 100 ? await users.userForToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    req.token = token;
    return next();
  } catch (err) {
    return next(err);
  }
}

const OWNER_ONLY = 'Only the owner can do this. Ask the owner if you need it.';

function ownerOnly(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  return res.status(403).json({ error: OWNER_ONLY });
}

// Team members can look, only the owner can change things.
function ownerForChanges(req, res, next) {
  if (req.method === 'GET') return next();
  return ownerOnly(req, res, next);
}

module.exports = { requireInboxAuth, ownerOnly, ownerForChanges };
