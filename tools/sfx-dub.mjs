// Build a sound-effect track for the doom-c15t.mov screen capture and mux it
// onto the (silent) video. Cue times were derived by frame analysis:
//   - pistol shots  -> muzzle-flash luma spikes, cross-checked against the HUD
//     ammo counter (50 -> 45 -> 42 -> ... -> 35, every shot accounted for).
//   - consent click -> the wall banner flips to "CONSENT SAVED" at t~6.15.
//   - pickups       -> INTH/green-armor grab (~14.85, armor 0->100%) and a
//     clip pickup (~36.5, ammo went back up).
//   - enemy/gib SFX -> inferred from cookies on screen during the bursts and
//     the red point-blank bloom at the end. Tag "flavor": easy to tweak/cut.
//
//   node tools/sfx-dub.mjs            # write /tmp/sfxmix.wav
//   node tools/sfx-dub.mjs --print    # just list cues
import { readFileSync, writeFileSync } from 'node:fs';

const SFX_DIR = new URL('../doom-assets/sfx/', import.meta.url);
const OUT_RATE = 44100;
const DURATION = 45.16; // seconds; matches the capture
const TARGET = '/tmp/sfxmix.wav';

// time(s), sound name (lump minus DS, see doom-assets/sfx/), gain, label
const CUES = [
  [6.15, 'swtchn', 1.0, 'consent "Accept All" click'],
  [8.55, 'doropn', 0.7, 'banner slides up'],
  [14.85, 'itemup', 1.0, 'INTH armor pickup'],
  // ── firefight 1 ──
  [26.4, 'posact', 0.6, 'cookie stirs (flavor)'],
  [26.78, 'pistol', 1.0, 'shot'],
  [27.37, 'pistol', 1.0, 'shot'],
  [28.02, 'pistol', 1.0, 'shot'],
  [28.97, 'pistol', 1.0, 'shot'],
  [29.38, 'pistol', 1.0, 'shot'],
  [29.7, 'podth2', 0.85, 'cookie dies (flavor)'],
  // ── firefight 2 ──
  [33.82, 'pistol', 1.0, 'shot'],
  [34.2, 'pistol', 1.0, 'shot'],
  [34.8, 'pistol', 1.0, 'shot'],
  [35.33, 'pistol', 1.0, 'shot'],
  [36.5, 'itemup', 1.0, 'clip pickup'],
  // ── firefight 3 ──
  [39.7, 'posact', 0.6, 'cookie stirs (flavor)'],
  [40.08, 'pistol', 1.0, 'shot'],
  [40.5, 'pistol', 1.0, 'shot'],
  [40.9, 'pistol', 1.0, 'shot'],
  [41.28, 'pistol', 1.0, 'shot'],
  [41.72, 'pistol', 1.0, 'shot'],
  [42.1, 'pistol', 1.0, 'shot'],
  [42.5, 'pistol', 1.0, 'shot'],
  [42.88, 'pistol', 1.0, 'shot'],
  [43.32, 'pistol', 1.0, 'shot'],
  [43.7, 'pistol', 1.0, 'shot'],
  [44.08, 'pistol', 1.0, 'shot'],
  [44.55, 'slop', 1.0, 'point-blank gib (red bloom)'],
];

// Parse an 8-bit unsigned mono WAV (what sfx-export.mjs writes) into
// { rate, samples: Float32Array in [-1,1] }.
function loadWav(name) {
  const b = readFileSync(new URL(`${name}.wav`, SFX_DIR));
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${name}: not RIFF`);
  // Walk chunks to find fmt + data (header is fixed here, but be tolerant).
  let rate = 11025, bits = 8, ch = 1, dataOfs = 44, dataLen = b.length - 44;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      ch = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    } else if (id === 'data') {
      dataOfs = p + 8;
      dataLen = sz;
      break;
    }
    p += 8 + sz + (sz & 1);
  }
  if (bits !== 8 || ch !== 1) throw new Error(`${name}: expected 8-bit mono`);
  const n = dataLen;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = (b[dataOfs + i] - 128) / 128;
  return { rate, samples };
}

// Linear-resample mono float samples from `rate` to OUT_RATE.
function resample(samples, rate) {
  if (rate === OUT_RATE) return samples;
  const ratio = OUT_RATE / rate;
  const out = new Float32Array(Math.round(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const s = i / ratio;
    const i0 = Math.floor(s);
    const frac = s - i0;
    const a = samples[i0] ?? 0;
    const c = samples[i0 + 1] ?? a;
    out[i] = a + (c - a) * frac;
  }
  return out;
}

if (process.argv.includes('--print')) {
  for (const [t, name, g, label] of CUES)
    console.log(`  ${t.toFixed(2).padStart(6)}s  ${name.padEnd(7)} x${g}  ${label}`);
  console.log(`\n${CUES.length} cues`);
  process.exit(0);
}

// Mix into a float accumulator (mono — the SFX are all mono/centered).
const total = Math.ceil(DURATION * OUT_RATE);
const mix = new Float32Array(total);
const cache = new Map();
for (const [t, name, gain] of CUES) {
  if (!cache.has(name)) {
    const w = loadWav(name);
    cache.set(name, resample(w.samples, w.rate));
  }
  const s = cache.get(name);
  const start = Math.round(t * OUT_RATE);
  for (let i = 0; i < s.length; i++) {
    const o = start + i;
    if (o >= total) break;
    mix[o] += s[i] * gain;
  }
}

// Find peak for headroom; normalize only if we'd clip.
let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(mix[i]));
const norm = peak > 0.98 ? 0.98 / peak : 1;

// Write 16-bit stereo (duplicated mono) WAV.
const dataBytes = total * 2 * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0, 'ascii');
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVE', 8, 'ascii');
buf.write('fmt ', 12, 'ascii');
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(2, 22); // stereo
buf.writeUInt32LE(OUT_RATE, 24);
buf.writeUInt32LE(OUT_RATE * 2 * 2, 28);
buf.writeUInt16LE(4, 32); // block align
buf.writeUInt16LE(16, 34); // bits
buf.write('data', 36, 'ascii');
buf.writeUInt32LE(dataBytes, 40);
let o = 44;
for (let i = 0; i < total; i++) {
  let v = Math.round(mix[i] * norm * 32767);
  if (v > 32767) v = 32767;
  if (v < -32768) v = -32768;
  buf.writeInt16LE(v, o);
  buf.writeInt16LE(v, o + 2);
  o += 4;
}
writeFileSync(TARGET, buf);
console.log(`wrote ${TARGET}  (${CUES.length} cues, ${DURATION}s, peak ${peak.toFixed(2)}${norm < 1 ? `, scaled x${norm.toFixed(2)}` : ''})`);
