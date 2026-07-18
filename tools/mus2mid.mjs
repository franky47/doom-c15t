// MUS -> Standard MIDI (type 0) converter.
// Faithful port of chocolate-doom's src/mus2mid.c (GPLv2). Produces a plain
// General-MIDI file: division 70 ticks/quarter, default 120 BPM, so 1 MUS tic
// (the engine's 140 Hz) == 1 MIDI tick == 1/140 s. No tempo meta is written
// (matches vanilla), so players use 120 BPM and the speed comes out right.
//
//   node tools/mus2mid.mjs <in.mus> <out.mid>
import { readFileSync, writeFileSync } from 'node:fs';

// MUS controller number -> MIDI controller number.
const CONTROLLER_MAP = [
  0x00, 0x20, 0x01, 0x07, 0x0a, 0x0b, 0x5b, 0x5d,
  0x40, 0x43, 0x78, 0x7b, 0x7e, 0x7f, 0x79,
];
const MIDI_PERCUSSION_CHAN = 9;
const MUS_PERCUSSION_CHAN = 15;

export function mus2mid(mus) {
  if (mus.toString('ascii', 0, 3) !== 'MUS') throw new Error('not a MUS lump');
  const scoreStart = mus.readUInt16LE(6);

  const track = []; // MIDI track bytes (everything after the MTrk length field)
  let queuedTime = 0; // delta ticks pending before the next event
  const channelMap = new Array(16).fill(-1);
  const channelVel = new Array(16).fill(127);

  // Variable-length quantity (MIDI delta-time / time code), big-endian 7-bit.
  const writeTime = () => {
    let t = queuedTime >>> 0;
    const buf = [t & 0x7f];
    while ((t >>>= 7) !== 0) buf.unshift((t & 0x7f) | 0x80);
    for (const b of buf) track.push(b);
    queuedTime = 0;
  };
  const ev = (...bytes) => {
    writeTime();
    for (const b of bytes) track.push(b & 0xff);
  };

  const allocChannel = () => {
    let max = -1;
    for (const c of channelMap) if (c > max) max = c;
    let r = max + 1;
    if (r === MIDI_PERCUSSION_CHAN) r++;
    return r;
  };
  const midiChannel = (musCh) => {
    if (musCh === MUS_PERCUSSION_CHAN) return MIDI_PERCUSSION_CHAN;
    if (channelMap[musCh] === -1) {
      channelMap[musCh] = allocChannel();
      // First use: emit "all notes off" (fixes the D_DDTBLU bug).
      ev(0xb0 | channelMap[musCh], 0x7b, 0x00);
    }
    return channelMap[musCh];
  };

  let p = scoreStart;
  let done = false;
  while (!done) {
    // Process one block of events (until an event with the 0x80 "time" flag).
    for (;;) {
      const desc = mus[p++];
      const ch = midiChannel(desc & 0x0f);
      const event = desc & 0x70;

      if (event === 0x00) { // release key
        const key = mus[p++];
        ev(0x80 | ch, key & 0x7f, 0x00);
      } else if (event === 0x10) { // press key
        let key = mus[p++];
        if (key & 0x80) channelVel[ch] = mus[p++] & 0x7f;
        ev(0x90 | ch, key & 0x7f, channelVel[ch] & 0x7f);
      } else if (event === 0x20) { // pitch wheel
        const wheel = mus[p++] * 64;
        ev(0xe0 | ch, wheel & 0x7f, (wheel >> 7) & 0x7f);
      } else if (event === 0x30) { // system event (valueless controller)
        const num = mus[p++];
        ev(0xb0 | ch, CONTROLLER_MAP[num], 0x00);
      } else if (event === 0x40) { // change controller
        const num = mus[p++];
        const val = mus[p++];
        if (num === 0) ev(0xc0 | ch, val & 0x7f); // patch change
        else ev(0xb0 | ch, CONTROLLER_MAP[num], val & 0x80 ? 0x7f : val);
      } else if (event === 0x60) { // score end
        done = true;
      } else {
        throw new Error(`bad MUS event ${event.toString(16)} at ${p - 1}`);
      }

      if (done || desc & 0x80) break;
    }
    if (!done) {
      // Read the time code (variable-length, base-128) and queue it.
      let delay = 0, b;
      do { b = mus[p++]; delay = delay * 128 + (b & 0x7f); } while (b & 0x80);
      queuedTime += delay;
    }
  }

  // End of track.
  writeTime();
  track.push(0xff, 0x2f, 0x00);

  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd, len 6
    0x00, 0x00, 0x00, 0x01, 0x00, 0x46, // type 0, 1 track, division 70
    0x4d, 0x54, 0x72, 0x6b, // MTrk
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(track.length, 0);
  return Buffer.concat([header, len, Buffer.from(track)]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: node tools/mus2mid.mjs <in.mus> <out.mid>');
    process.exit(1);
  }
  const mid = mus2mid(readFileSync(inPath));
  writeFileSync(outPath, mid);
  console.log(`wrote ${outPath} (${mid.length} bytes)`);
}
