// Split a MIDI file into one track per channel (type-1), or extract a single
// channel. Useful because type-0 files (one track, many channels — what
// mus2mid.mjs emits) get flattened to a single track by some DAWs (Ableton),
// merging drums in with the melodic parts. Splitting keeps each part — notably
// the channel-10 percussion — on its own track to route to separate gear.
//
//   node tools/midi-split.mjs in.mid                 -> in_split.mid (per channel)
//   node tools/midi-split.mjs in.mid --only 10       -> in_ch10.mid (1-indexed ch)
import { readFileSync, writeFileSync } from 'node:fs';

const dataBytesFor = (status) => {
  const hi = status & 0xf0;
  return hi === 0xc0 || hi === 0xd0 ? 1 : 2; // program & channel-pressure take 1
};

// Parse a MIDI file -> { division, events:[{tick,bytes,channel|null}] }.
// channel is null for meta/sysex (global) events; end-of-track is dropped.
function parseMidi(b) {
  if (b.toString('ascii', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const ntracks = b.readUInt16BE(10);
  const division = b.readUInt16BE(12);
  const events = [];
  let p = 14;
  for (let t = 0; t < ntracks; t++) {
    if (b.toString('ascii', p, p + 4) !== 'MTrk') throw new Error(`bad track ${t}`);
    const len = b.readUInt32BE(p + 4);
    let q = p + 8;
    const end = q + len;
    let tick = 0;
    let running = 0;
    while (q < end) {
      // delta time (varlen)
      let dt = 0, c;
      do { c = b[q++]; dt = (dt << 7) | (c & 0x7f); } while (c & 0x80);
      tick += dt;
      let status = b[q];
      if (status & 0x80) q++; else status = running; // running status
      if (status === 0xff) { // meta
        const type = b[q++];
        let l = 0; do { c = b[q++]; l = (l << 7) | (c & 0x7f); } while (c & 0x80);
        const data = b.subarray(q, q + l); q += l;
        if (type !== 0x2f) // drop end-of-track; regenerated on write
          events.push({ tick, bytes: [0xff, type, ...encodeVar(l), ...data], channel: null });
      } else if (status === 0xf0 || status === 0xf7) { // sysex
        let l = 0; do { c = b[q++]; l = (l << 7) | (c & 0x7f); } while (c & 0x80);
        const data = b.subarray(q, q + l); q += l;
        events.push({ tick, bytes: [status, ...encodeVar(l), ...data], channel: null });
      } else { // channel voice
        running = status;
        const n = dataBytesFor(status);
        const data = [b[q], b[q + 1]].slice(0, n); q += n;
        events.push({ tick, bytes: [status, ...data], channel: status & 0x0f });
      }
    }
    p = end;
  }
  return { division, events };
}

function encodeVar(value) {
  const out = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>>= 7; }
  return out;
}

function nameForChannel(ch) {
  if (ch === 9) return 'Drums (ch10)';
  return `Ch ${ch + 1}`;
}

// Build an MTrk chunk from absolute-tick events (sorted), prepending an
// optional track-name meta, appending end-of-track.
function buildTrack(events, name) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const body = [];
  let last = 0;
  if (name) {
    const nm = [...Buffer.from(name, 'ascii')];
    body.push(0x00, 0xff, 0x03, ...encodeVar(nm.length), ...nm);
  }
  for (const e of sorted) {
    body.push(...encodeVar(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00); // end of track
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, Buffer.from(body)]);
}

function writeMidi(division, tracks) {
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(tracks.length > 1 ? 1 : 0, 8); // format
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(division, 12);
  return Buffer.concat([header, ...tracks]);
}

const [, , inPath, ...rest] = process.argv;
if (!inPath) { console.error('usage: node tools/midi-split.mjs in.mid [--only <ch 1-16>]'); process.exit(1); }
const onlyIdx = rest.indexOf('--only');
const { division, events } = parseMidi(readFileSync(inPath));

const channels = [...new Set(events.filter((e) => e.channel !== null).map((e) => e.channel))].sort((a, b) => a - b);
const globals = events.filter((e) => e.channel === null); // tempo/timesig etc.

if (onlyIdx >= 0) {
  const ch = parseInt(rest[onlyIdx + 1], 10) - 1; // 1-indexed -> 0-indexed
  const evs = [...globals, ...events.filter((e) => e.channel === ch)];
  const out = writeMidi(division, [buildTrack(evs, nameForChannel(ch))]);
  const outPath = inPath.replace(/\.mid$/i, `_ch${ch + 1}.mid`);
  writeFileSync(outPath, out);
  console.log(`wrote ${outPath} (channel ${ch + 1}, ${events.filter((e) => e.channel === ch).length} events)`);
} else {
  // type-1: optional conductor track (globals) then one track per channel.
  const tracks = [];
  if (globals.length) tracks.push(buildTrack(globals, 'Conductor'));
  for (const ch of channels) tracks.push(buildTrack(events.filter((e) => e.channel === ch), nameForChannel(ch)));
  const out = writeMidi(division, tracks);
  const outPath = inPath.replace(/\.mid$/i, '_split.mid');
  writeFileSync(outPath, out);
  console.log(`wrote ${outPath} (${tracks.length} tracks: ${channels.map((c) => c + 1).join(', ')}${globals.length ? ' + conductor' : ''})`);
}
