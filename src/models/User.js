const mongoose = require('mongoose');

// A person who can log in to the inbox: the owner(s) and team members.
// (The INBOX_API_KEY access code also logs in, as the owner.)
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // 'owner': everything · 'team': chats, cart links, customers, COD orders
    role: { type: String, enum: ['owner', 'team'], default: 'team' },
    passwordHash: { type: String, required: true },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
