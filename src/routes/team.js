// Logging in and out, your own account, and (owner only) the team.
const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const users = require('../services/users');
const pushNotify = require('../services/pushNotify');
const { ownerOnly } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');

const ID_RE = /^[a-f0-9]{24}$/;

// POST /api/login - no access code needed (mounted before the auth check).
const login = asyncHandler(async (req, res) => {
  const out = await users.login(req.body.email, req.body.password, req.ip);
  if (out.error) return res.status(out.status).json({ error: out.error });
  const token = await users.createSession(out.user, req.headers['user-agent']);
  res.json({ token, user: users.publicUser(out.user) });
});

const router = express.Router();

router.get('/me', (req, res) => res.json(users.publicUser(req.user)));

router.post('/logout', asyncHandler(async (req, res) => {
  if (req.token) await users.endSession(req.token);
  res.json({ ok: true });
}));

router.post('/me/password', asyncHandler(async (req, res) => {
  if (req.user.viaCode) return res.status(400).json({ error: 'You logged in with the access code, which has no password. Add yourself on the Team page to get your own login.' });
  const user = await User.findById(req.user._id);
  if (!user || !users.verifyPassword(req.body.current, user.passwordHash)) return res.status(400).json({ error: 'Your current password is wrong' });
  const problem = users.passwordProblem(req.body.password);
  if (problem) return res.status(400).json({ error: problem });
  user.passwordHash = users.hashPassword(req.body.password);
  await user.save();
  // Other devices log out; this one stays in.
  await Session.deleteMany({ userId: user._id, _id: { $ne: req.user.sessionId } });
  res.json({ ok: true });
}));

// ---------- Notifications on this device ----------
router.get('/push/key', asyncHandler(async (req, res) => {
  res.json({ publicKey: await pushNotify.publicKey() });
}));

router.post('/push/subscribe', asyncHandler(async (req, res) => {
  await pushNotify.subscribe(req.user, req.body.subscription, req.headers['user-agent']);
  res.json({ ok: true });
}));

router.post('/push/unsubscribe', asyncHandler(async (req, res) => {
  await pushNotify.unsubscribe(req.body.endpoint);
  res.json({ ok: true });
}));

// Sends a notification to your own devices, to check it works.
router.post('/push/test', asyncHandler(async (req, res) => {
  const out = await pushNotify.send(
    { title: 'Notifications are working', body: "You'll get one like this for new messages, tickets and reminders.", url: '/#/home' },
    { userId: req.user._id }
  );
  if (!out.devices) return res.status(400).json({ error: 'Turn on notifications on this device first' });
  res.json(out);
}));

// ---------- Team (owner only) ----------
function memberOut(u, sessions = 0) {
  return { _id: String(u._id), name: u.name, email: u.email, role: u.role, active: u.active, lastLoginAt: u.lastLoginAt, devices: sessions };
}

router.get('/team', ownerOnly, asyncHandler(async (req, res) => {
  const list = await User.find({ active: true }).sort({ role: 1, name: 1 }).lean();
  const counts = await Session.aggregate([{ $match: { expiresAt: { $gt: new Date() } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]);
  const byUser = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(list.map((u) => memberOut(u, byUser.get(String(u._id)) || 0)));
}));

// Adds someone. Returns a temporary password to share with them once.
router.post('/team', ownerOnly, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const email = users.cleanEmail(req.body.email);
  const role = req.body.role === 'owner' ? 'owner' : 'team';
  if (!name) return res.status(400).json({ error: 'Type their name' });
  if (!email) return res.status(400).json({ error: 'Type a valid email address' });
  const password = users.temporaryPassword();
  const existing = await User.findOne({ email });
  if (existing && existing.active) return res.status(409).json({ error: 'Someone with that email is already on the team' });
  let user;
  if (existing) {
    Object.assign(existing, { name, role, active: true, passwordHash: users.hashPassword(password) });
    user = await existing.save();
  } else {
    user = await User.create({ name, email, role, passwordHash: users.hashPassword(password) });
  }
  res.status(201).json({ member: memberOut(user), password });
}));

router.patch('/team/:id', ownerOnly, asyncHandler(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  const user = await User.findOne({ _id: req.params.id, active: true });
  if (!user) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) user.name = req.body.name.trim().slice(0, 60);
  if (['owner', 'team'].includes(req.body.role)) {
    if (String(user._id) === req.user._id && req.body.role !== 'owner') return res.status(400).json({ error: "You can't take away your own owner access" });
    user.role = req.body.role;
  }
  await user.save();
  users.clearCache();
  res.json(memberOut(user));
}));

router.post('/team/:id/reset-password', ownerOnly, asyncHandler(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  const user = await User.findOne({ _id: req.params.id, active: true });
  if (!user) return res.status(404).json({ error: 'not found' });
  const password = users.temporaryPassword();
  user.passwordHash = users.hashPassword(password);
  await user.save();
  await users.endAllSessions(user._id);
  res.json({ password });
}));

// Removes access at once (logs them out everywhere). Their name stays on
// the replies they sent.
router.delete('/team/:id', ownerOnly, asyncHandler(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  if (req.params.id === req.user._id) return res.status(400).json({ error: "You can't remove yourself" });
  const user = await User.findOneAndUpdate({ _id: req.params.id, active: true }, { $set: { active: false } }, { new: true });
  if (!user) return res.status(404).json({ error: 'not found' });
  await users.endAllSessions(user._id);
  res.json({ ok: true });
}));

module.exports = { router, login };
