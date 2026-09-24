// Logins for the owner and team members: password hashing, sessions and
// the "who is this" check behind every API call.
const crypto = require('crypto');
const User = require('../models/User');
const Session = require('../models/Session');

const SESSION_DAYS = 60;
const MIN_PASSWORD = 8;

// The access code (INBOX_API_KEY) logs in as this owner.
function codeOwner() {
  return { _id: 'owner', name: String(process.env.FOUNDER_NAME || '').trim() || 'Owner', email: '', role: 'owner', viaCode: true };
}

// ---------- Passwords (scrypt, built into Node) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function passwordProblem(password) {
  if (String(password || '').length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  return null;
}

// Easy to read out or type from a phone: e.g. "mango-7314-kite".
const WORDS = ['mango', 'kite', 'river', 'lotus', 'tiger', 'pearl', 'cedar', 'amber', 'maple', 'coral', 'saffron', 'jasmine', 'falcon', 'orbit', 'monsoon', 'garnet'];
function temporaryPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${crypto.randomInt(1000, 10000)}-${pick()}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase().slice(0, 120);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// ---------- Sessions ----------
async function createSession(user, device = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  await Session.create({
    tokenHash: sha256(token),
    userId: user._id,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
    device: String(device || '').slice(0, 200),
  });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return token;
}

// Short cache so every API call doesn't hit the database twice.
const cache = new Map();
const CACHE_MS = 30 * 1000;

async function userForToken(token) {
  const key = sha256(token);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.user;
  const session = await Session.findOne({ tokenHash: key, expiresAt: { $gt: new Date() } }).lean();
  let user = null;
  if (session) {
    const u = await User.findOne({ _id: session.userId, active: true }).select('name email role').lean();
    if (u) user = { _id: String(u._id), name: u.name, email: u.email, role: u.role, sessionId: String(session._id) };
    if (u && Date.now() - new Date(session.lastUsedAt).getTime() > 60 * 60 * 1000) {
      Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
  }
  cache.set(key, { at: Date.now(), user });
  return user;
}

async function endSession(token) {
  cache.delete(sha256(token));
  await Session.deleteOne({ tokenHash: sha256(token) });
}

// Logs someone out everywhere (removed from the team, password reset).
async function endAllSessions(userId) {
  cache.clear();
  await Session.deleteMany({ userId });
}

// So a changed role or name applies straight away.
function clearCache() {
  cache.clear();
}

// ---------- Login attempts ----------
const attempts = new Map(); // key -> { n, until }
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;

function tooManyAttempts(key) {
  const a = attempts.get(key);
  return !!(a && a.n >= MAX_ATTEMPTS && a.until > Date.now());
}

function recordFailure(key) {
  const a = attempts.get(key);
  const fresh = !a || a.until < Date.now();
  attempts.set(key, { n: fresh ? 1 : a.n + 1, until: Date.now() + LOCK_MS });
}

function clearFailures(key) {
  attempts.delete(key);
}

async function login(email, password, ip) {
  const clean = cleanEmail(email);
  const keys = [`ip:${ip}`, `email:${clean}`];
  if (keys.some(tooManyAttempts)) return { error: 'Too many tries. Wait 15 minutes and try again.', status: 429 };
  const user = clean ? await User.findOne({ email: clean, active: true }) : null;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    keys.forEach(recordFailure);
    return { error: 'That email and password don’t match.', status: 401 };
  }
  keys.forEach(clearFailures);
  return { user };
}

function publicUser(u) {
  return { _id: String(u._id), name: u.name, email: u.email || '', role: u.role, viaCode: !!u.viaCode };
}

module.exports = {
  codeOwner,
  hashPassword,
  verifyPassword,
  passwordProblem,
  temporaryPassword,
  cleanEmail,
  createSession,
  userForToken,
  endSession,
  endAllSessions,
  clearCache,
  login,
  publicUser,
  tooManyAttempts,
  recordFailure,
};
