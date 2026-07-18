// Remap note numbers of note-on/note-off events (optionally only on one
// channel) using a JSON {fromNote: toNote} map. Built to retarget Doom's
// GM-percussion drum track onto an Arturia KeyStep Pro drum track (parts ->
// notes 36..59) driving Korg Volca Sample/Drum voices. Notes not present in
// the map are dropped (so they can't trigger unrouted KSP parts).
//
//   node tools/midi-remap.mjs in.mid out.mid map.json [--channel 10]
import { readFileSync, writeFileSync } from 'node:fs';

function encodeVar(value) {
  const out = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>>= 7; }
  return out;
}

const [, , inPath, outPath, mapPath, ...rest] = process.argv;
if (!inPath || !outPath || !mapPath) {
  console.error('usage: node tools/midi-remap.mjs in.mid out.mid map.json [--channel N]');
  process.exit(1);
}
const ci = rest.indexOf('--channel');
const onlyChannel = ci >= 0 ? parseInt(rest[ci + 1], 10) - 1 : null; // 1-indexed
const map = JSON.parse(readFileSync(mapPath, 'utf8')); // { "36": 48, ... }
const remap = (n) => (n in map ? map[n] : (`${n}` in map ? map[`${n}`] : undefined));

const b = readFileSync(inPath);
if (b.toString('ascii', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
const ntracks = b.readUInt16BE(10);
const division = b.readUInt16BE(12);

const out = [b.subarray(0, 14)];
let p = 14;
let dropped = 0, mapped = 0;
for (let t = 0; t < ntracks; t++) {
  const len = b.readUInt32BE(p + 4);
  let q = p + 8;
  const end = q + len;
  const body = [];
  let run = 0;
  let pendingDelta = 0; // carry delta of a dropped event onto the next kept one
  while (q < end) {
    let dt = 0, c;
    do { c = b[q++]; dt = (dt << 7) | (c & 0x7f); } while (c & 0x80);
    let status = b[q];
    if (status & 0x80) q++; else status = run;
    let evBytes;
    if (status === 0xff) {
      const ty = b[q++];
      let l = 0; do { c = b[q++]; l = (l << 7) | (c & 0x7f); } while (c & 0x80);
      evBytes = [0xff, ty, ...encodeVar(l), ...b.subarray(q, q + l)]; q += l;
    } else if (status === 0xf0 || status === 0xf7) {
      let l = 0; do { c = b[q++]; l = (l << 7) | (c & 0x7f); } while (c & 0x80);
      evBytes = [status, ...encodeVar(l), ...b.subarray(q, q + l)]; q += l;
    } else {
      run = status;
      const hi = status & 0xf0;
      const ch = status & 0x0f;
      const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
      const d = [b[q], b[q + 1]].slice(0, n);
      q += n;
      const isNote = hi === 0x80 || hi === 0x90;
      if (isNote && (onlyChannel === null || ch === onlyChannel)) {
        const to = remap(d[0]);
        if (to === undefined) { // drop: carry its delta forward
          pendingDelta += dt;
          continue;
        }
        d[0] = to; mapped++;
      }
      evBytes = [status, ...d];
    }
    body.push(...encodeVar(dt + pendingDelta), ...evBytes);
    pendingDelta = 0;
  }
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  out.push(head, Buffer.from(body));
  p = end;
}
writeFileSync(outPath, Buffer.concat(out));
console.log(`wrote ${outPath}  (remapped ${mapped} note events, dropped ${dropped}, division ${division})`);
