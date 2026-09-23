const mongoose = require('mongoose');

// A tiny named-sequence collection so we can hand out ticket numbers atomically.
// One document per sequence (e.g. _id: "ticketNumber"), incremented with a
// single $inc so two concurrent webhook messages can never grab the same number.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

// Atomically increments and returns the next value for the named sequence.
counterSchema.statics.next = async function (name, startAt = 0) {
  const doc = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 }, $setOnInsert: { _id: name } },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  );
  // On first-ever call the doc starts at seq 1; add the caller's base offset so
  // ticket numbers can begin at, say, 1001 instead of 1.
  return startAt + doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
