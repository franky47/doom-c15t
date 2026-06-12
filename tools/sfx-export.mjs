// Extract Doom DMX sound-effect lumps (DS*) from the embedded DOOM1.WAD into
// per-sound WAV files plus an index manifest.
//
// DMX sound lump layout:
//   u16 format   (always 3 = PCM)
//   u16 rate     (samples/sec, e.g. 11025)
//   u32 nsamp    (sample count, INCLUDING the pad bytes below)
//   16 bytes     lead-in padding  (== first real sample)
//   nsamp-32     unsigned-8-bit PCM samples
//   16 bytes     lead-out padding (== last real sample)
//
// 8-bit WAV PCM is also unsigned, so sample bytes copy straight across.
//
//   node tools/sfx-export.mjs            # write WAVs + index.json
//   node tools/sfx-export.mjs --list     # just print the table, write nothing
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadWasm, readDirectory } from './doom-gfx.mjs';

const OUT_DIR = new URL('../doom-assets/sfx/', import.meta.url);
const PAD = 16; // DMX lead-in / lead-out padding, in samples

// Parse a DMX lump buffer -> { format, rate, pcm } where pcm has the padding
// trimmed. Returns null if it isn't a DMX format-3 lump.
function decodeDmx(b) {
  if (b.length < 8) return null;
  const format = b.readUInt16LE(0);
  const rate = b.readUInt16LE(2);
  const nsamp = b.readUInt32LE(4);
  if (format !== 3) return null;
  // Clamp to what's actually present, then drop the pad on both ends.
  const avail = Math.min(nsamp, b.length - 8);
  const start = 8 + Math.min(PAD, avail);
  const end = 8 + Math.max(start - 8, avail - PAD);
  const pcm = b.subarray(start, end);
  return { format, rate, pcm };
}

function wav8(rate, pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // byte rate (1 ch * 1 byte)
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits/sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const wasm = loadWasm();
const dir = readDirectory(wasm);
const sfx = dir.filter((d) => d.name.startsWith('DS'));
const listOnly = process.argv.includes('--list');

if (!listOnly) mkdirSync(OUT_DIR, { recursive: true });

const index = [];
let totalPcm = 0;
for (const l of sfx) {
  const b = wasm.subarray(l.fileOfs, l.fileOfs + l.size);
  const d = decodeDmx(b);
  if (!d) {
    console.warn(`  skip ${l.name} (not DMX format 3)`);
    continue;
  }
  // Doom's runtime sound name is the lump name minus the "DS" prefix.
  const name = l.name.slice(2).toLowerCase();
  const seconds = d.pcm.length / d.rate;
  index.push({ name, lump: l.name, rate: d.rate, samples: d.pcm.length, seconds: +seconds.toFixed(3) });
  totalPcm += d.pcm.length;
  if (!listOnly) writeFileSync(new URL(`${name}.wav`, OUT_DIR), wav8(d.rate, d.pcm));
}

index.sort((a, b) => a.name.localeCompare(b.name));
console.log(`${index.length} SFX, ${(totalPcm / 1024).toFixed(0)} KiB PCM total\n`);
for (const e of index) {
  console.log(`  ${e.name.padEnd(8)} ${String(e.rate).padStart(5)}Hz  ${String(e.samples).padStart(6)} samp  ${e.seconds.toFixed(2)}s`);
}

if (!listOnly) {
  writeFileSync(new URL('index.json', OUT_DIR), JSON.stringify(index, null, 2) + '\n');
  console.log(`\nwrote ${index.length} WAVs + index.json to doom-assets/sfx/`);
}
