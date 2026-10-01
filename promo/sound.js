// Builds the feature film's soundtrack: a calm music bed (tanpura-style drone
// and soft kalimba plucks in D) plus UI sound effects on the cues that
// features.html exposes as window.SOUND_CUES. Everything is synthesised here,
// so there's nothing to license.
//
//   node promo/sound.js cues.json out.wav
//   cues.json: { "duration": 61.8, "cues": [{ "T": 0.2, "type": "thump" }, ...] }
const fs = require('fs');

const SR = 48000;
const TAU = Math.PI * 2;

// Deterministic noise, so every render sounds the same.
let seed = 12345;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

class Track {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.l = new Float32Array(this.n);
    this.r = new Float32Array(this.n);
  }
  // Add a mono sample function f(time since start) for `len` seconds at `at`, panned -1..1.
  add(at, len, f, gain = 1, pan = 0) {
    const start = Math.floor(at * SR);
    const end = Math.min(this.n, start + Math.ceil(len * SR));
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = Math.max(0, start); i < end; i++) {
      const v = f((i - start) / SR);
      this.l[i] += v * gl;
      this.r[i] += v * gr;
    }
  }
  mix(other, gain = 1) {
    for (let i = 0; i < this.n; i++) {
      this.l[i] += other.l[i] * gain;
      this.r[i] += other.r[i] * gain;
    }
  }
}

// ---- Instruments ----------------------------------------------------------------
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

// Tanpura-ish string: bright harmonics that bloom and fade slowly (the "jawari" buzz).
function tanpura(f) {
  const parts = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ k, a: 1 / k, d: 2.2 + k * 0.35, ph: k * 1.7 }));
  return (t) => {
    let v = 0;
    for (const { k, a, d, ph } of parts) {
      const bloom = 1 - Math.exp(-t * (1.5 + k * 0.4));
      v += a * bloom * Math.exp(-t / d) * Math.sin(TAU * f * k * t + ph + 0.3 * Math.sin(TAU * 0.7 * t));
    }
    return v * 0.25 * Math.min(1, t / 0.02);
  };
}

// Kalimba / soft marimba pluck: sine + a quick bright partial.
const pluck = (f, decay = 0.9) => (t) =>
  env(t, 0.003, decay) * (Math.sin(TAU * f * t) + 0.18 * Math.sin(TAU * f * 4.02 * t) * Math.exp(-t / 0.08));

// Warm pad: a few detuned triangles with a slow swell.
const tri = (x) => 2 * Math.abs(2 * (x - Math.floor(x + 0.5))) - 1;
const pad = (f, len) => (t) => {
  const a = Math.min(1, t / 1.2) * Math.min(1, (len - t) / 1.0);
  return a * (tri(f * t) + tri(f * 1.004 * t) * 0.8 + Math.sin(TAU * f * 0.5 * t) * 0.6) / 3;
};

// Bell with inharmonic partials, for chimes and alerts.
const bell = (f, decay = 1.0) => (t) =>
  env(t, 0.002, decay) * (Math.sin(TAU * f * t) + 0.45 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t / 0.4)
    + 0.2 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t / 0.15));

// One-pole filtered noise burst.
function noiseBurst(attack, decay, cutoff) {
  let y = 0;
  const a = Math.exp((-TAU * cutoff) / SR);
  return (t) => {
    y = (1 - a) * noise() + a * y;
    return y * env(t, attack, decay);
  };
}

// ---- Music bed ------------------------------------------------------------------
// D major at 80 BPM: D - A - Bm - G, one bar each (3s).
const BEAT = 60 / 80;
const CHORDS = [
  [50, 54, 57], // D
  [45, 49, 52], // A
  [47, 50, 54], // Bm
  [43, 47, 50], // G
];
const ARP = [0, 2, 1, 2, 0, 2, 1, 3]; // indexes into chord tones (+ octave for 3)

function music(duration, startArps, endAt) {
  const tr = new Track(duration);
  // Drone from the first second: Pa - Sa - Sa - low Sa, re-plucked every beat.
  const drone = [hz(45), hz(50), hz(50), hz(38)];
  for (let t = 0, i = 0; t < duration; t += BEAT, i++) {
    tr.add(t, 4.5, tanpura(drone[i % 4]), 0.9, (i % 2 ? 0.3 : -0.3));
  }
  // Pad and plucks once the phone appears; resolve on D for the end card.
  const bar = BEAT * 4;
  for (let b = 0, t = startArps; t < endAt; b++, t += bar) {
    const chord = CHORDS[b % CHORDS.length];
    for (const m of chord) tr.add(t, bar + 0.8, pad(hz(m), bar + 0.8), 0.22, 0);
    ARP.forEach((idx, i) => {
      const at = t + (i * BEAT) / 2;
      if (at >= endAt) return;
      const m = idx === 3 ? chord[0] + 12 : chord[idx];
      const vel = i % 4 === 0 ? 0.55 : 0.36;
      tr.add(at, 1.6, pluck(hz(m + 24), 0.7), vel, ((i % 3) - 1) * 0.45);
    });
  }
  // Final chord rings out under the logo.
  for (const m of [50, 57, 62, 66]) tr.add(endAt, duration - endAt, pad(hz(m), duration - endAt), 0.3, 0);
  [62, 66, 69, 74].forEach((m, i) => tr.add(endAt + i * 0.12, 3, pluck(hz(m + 12), 1.4), 0.4, (i - 1.5) * 0.3));
  reverb(tr, 0.32);
  // Fade in over the intro, fade out over the last 1.5s.
  for (let i = 0; i < tr.n; i++) {
    const t = i / SR;
    const g = Math.min(1, t / 2.5) * Math.min(1, (duration - t) / 1.5);
    tr.l[i] *= g;
    tr.r[i] *= g;
  }
  return tr;
}

// Small Schroeder reverb (4 combs + 2 allpasses per side), mixed in at `wet`.
function reverb(tr, wet) {
  const side = (input, offset) => {
    const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(d + offset), i: 0, fb: 0.8 }));
    const alls = [556, 441].map((d) => ({ buf: new Float32Array(d + offset), i: 0 }));
    const out = new Float32Array(input.length);
    for (let n = 0; n < input.length; n++) {
      let s = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.buf[c.i] = input[n] + y * c.fb;
        c.i = (c.i + 1) % c.buf.length;
        s += y;
      }
      s /= 4;
      for (const a of alls) {
        const y = a.buf[a.i];
        a.buf[a.i] = s + y * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        s = y - s * 0.5;
      }
      out[n] = s;
    }
    return out;
  };
  const wl = side(tr.l, 0);
  const wr = side(tr.r, 23);
  for (let i = 0; i < tr.n; i++) {
    tr.l[i] = tr.l[i] * (1 - wet * 0.5) + wl[i] * wet;
    tr.r[i] = tr.r[i] * (1 - wet * 0.5) + wr[i] * wet;
  }
}

// ---- Sound effects ----------------------------------------------------------------
const SFX = {
  // Soft finger tap.
  tap: (tr, at) => {
    tr.add(at, 0.06, (t) => Math.sin(TAU * 1600 * t) * Math.exp(-t / 0.012), 0.36);
    tr.add(at, 0.02, noiseBurst(0.0005, 0.004, 4000), 0.4);
  },
  // Incoming message: a little rising bloop.
  pop: (tr, at) =>
    tr.add(at, 0.2, (t) => Math.sin(TAU * (520 * t + 1800 * t * t)) * env(t, 0.004, 0.06), 0.42),
  // Automatic reply going out: a light upward swish.
  send: (tr, at) => {
    tr.add(at, 0.25, (t) => Math.sin(TAU * (900 * t + 1600 * t * t)) * env(t, 0.01, 0.05), 0.4, 0.2);
    tr.add(at, 0.25, noiseBurst(0.04, 0.06, 2500), 0.2, 0.2);
  },
  // Screen change: an airy whoosh.
  whoosh: (tr, at) => tr.add(at - 0.05, 0.6, noiseBurst(0.18, 0.12, 900), 0.3),
  rise: (tr, at) => tr.add(at, 1.2, noiseBurst(0.6, 0.25, 700), 0.25),
  // Something got done: two soft marimba notes up.
  success: (tr, at) => {
    tr.add(at, 0.8, pluck(hz(81), 0.3), 0.32, -0.1);
    tr.add(at + 0.09, 0.9, pluck(hz(86), 0.35), 0.32, 0.1);
  },
  // Jev flags an angry customer: an attention bell, falling.
  alert: (tr, at) => {
    tr.add(at, 1.4, bell(hz(83), 0.7), 0.3, -0.15);
    tr.add(at + 0.16, 1.6, bell(hz(78), 0.8), 0.3, 0.15);
  },
  // Phone notification: a three-note chime.
  chime: (tr, at) => [86, 90, 93].forEach((m, i) => tr.add(at + i * 0.09, 1.4, bell(hz(m), 0.6), 0.22, (i - 1) * 0.3)),
  // Money in: bright coins.
  kaching: (tr, at) => {
    tr.add(at, 0.05, noiseBurst(0.001, 0.01, 6000), 0.35);
    [96, 100, 103, 108].forEach((m, i) => tr.add(at + 0.05 + i * 0.03, 0.7, bell(hz(m), 0.25), 0.16, (i - 1.5) * 0.4));
    tr.add(at + 0.05, 0.6, (t) => noise() * env(t, 0.005, 0.12) * Math.sin(TAU * 7000 * t), 0.08);
  },
  toggle: (tr, at) => tr.add(at, 0.03, (t) => Math.sin(TAU * 3000 * t) * Math.exp(-t / 0.006), 0.3),
  // Intro words land; "All on you." lands harder.
  thump: (tr, at) => tr.add(at, 0.5, (t) => Math.sin(TAU * (70 * t - 20 * t * t)) * env(t, 0.003, 0.14), 0.6),
  hit: (tr, at) => {
    tr.add(at, 1.2, (t) => Math.sin(TAU * (58 * t - 12 * t * t)) * env(t, 0.004, 0.35), 0.8);
    tr.add(at, 0.4, noiseBurst(0.002, 0.08, 1200), 0.2);
  },
  // Logo reveal: a warm bloom.
  swell: (tr, at) => {
    tr.add(at - 0.6, 1.4, noiseBurst(0.9, 0.3, 1500), 0.18);
    for (const m of [62, 66, 69]) tr.add(at, 3, bell(hz(m + 12), 1.4), 0.12);
  },
};

// The music sits well under the effects.
const BED_GAIN = 0.09;

function main() {
  const [cuesPath, outPath] = process.argv.slice(2);
  if (!cuesPath || !outPath) throw new Error('usage: node promo/sound.js cues.json out.wav');
  const { duration, cues } = JSON.parse(fs.readFileSync(cuesPath, 'utf8'));

  // The plucks start when the phone rises and resolve when the logo appears.
  const rise = cues.find((c) => c.type === 'rise');
  const swell = cues.find((c) => c.type === 'swell');
  const bed = music(duration, rise ? rise.T : 3, swell ? swell.T : duration - 4);

  const fx = new Track(duration);
  for (const c of cues) {
    if (!SFX[c.type]) throw new Error(`Unknown sound cue "${c.type}"`);
    SFX[c.type](fx, c.T);
  }

  const out = new Track(duration);
  out.mix(bed, BED_GAIN);
  out.mix(fx, 1);

  let peak = 0;
  for (let i = 0; i < out.n; i++) peak = Math.max(peak, Math.abs(out.l[i]), Math.abs(out.r[i]));
  const g = 0.9 / (peak || 1);
  const buf = Buffer.alloc(44 + out.n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + out.n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(out.n * 4, 40);
  for (let i = 0; i < out.n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out.l[i] * g)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out.r[i] * g)) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath} (${duration.toFixed(1)}s, ${cues.length} cues)`);
}

if (require.main === module) main();
module.exports = { music, SFX, Track, BED_GAIN, SR };
