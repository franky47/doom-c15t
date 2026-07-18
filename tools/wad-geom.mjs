// Extract the embedded DOOM1.WAD from doom.wasm and dump E1M1 geometry so we
// can pick the wall that faces the player at spawn (between the two pillars
// bordering the pool).
import { readFileSync } from 'node:fs';

const WAD_EMBEDDED_OFFSET = 302042;
const wasm = readFileSync(new URL('../doom-assets/doom.wasm', import.meta.url));

// The WAD sits inside the wasm at the known offset. Read header from there.
const base = WAD_EMBEDDED_OFFSET;
const magic = wasm.toString('ascii', base, base + 4);
const numLumps = wasm.readInt32LE(base + 4);
const dirOfs = wasm.readInt32LE(base + 8);
console.log(`magic=${magic} numLumps=${numLumps} dirOfs=${dirOfs}`);

const dir = [];
for (let i = 0; i < numLumps; i++) {
  const e = base + dirOfs + i * 16;
  const ofs = wasm.readInt32LE(e);
  const size = wasm.readInt32LE(e + 4);
  let name = '';
  for (let k = 0; k < 8; k++) {
    const c = wasm[e + 8 + k];
    if (!c) break;
    name += String.fromCharCode(c);
  }
  dir.push({ index: i, name, ofs: base + ofs, size });
}

const e1m1 = dir.findIndex(d => d.name === 'E1M1');
console.log('E1M1 marker at dir index', e1m1);
// Map lumps follow the marker in fixed order.
const lumpByName = {};
for (let i = e1m1 + 1; i < e1m1 + 11; i++) {
  lumpByName[dir[i].name] = dir[i];
}
console.log('map lumps:', Object.keys(lumpByName).join(', '));

function readLump(name) {
  const l = lumpByName[name];
  return { buf: wasm.subarray(l.ofs, l.ofs + l.size), size: l.size };
}

// VERTEXES: int16 x, int16 y
const vtx = readLump('VERTEXES');
const vertexes = [];
for (let i = 0; i + 4 <= vtx.size; i += 4) {
  vertexes.push({ x: vtx.buf.readInt16LE(i), y: vtx.buf.readInt16LE(i + 2) });
}

// SIDEDEFS: xoff(2) yoff(2) upper(8) lower(8) middle(8) sector(2) = 30
const sd = readLump('SIDEDEFS');
const sidedefs = [];
for (let i = 0; i + 30 <= sd.size; i += 30) {
  const str = (o) => {
    let s = '';
    for (let k = 0; k < 8; k++) { const c = sd.buf[i + o + k]; if (!c) break; s += String.fromCharCode(c); }
    return s;
  };
  sidedefs.push({
    idx: sidedefs.length,
    xoff: sd.buf.readInt16LE(i),
    yoff: sd.buf.readInt16LE(i + 2),
    upper: str(4), lower: str(12), middle: str(20),
    sector: sd.buf.readUInt16LE(i + 28),
  });
}

// SECTORS: floorh(2) ceilh(2) floorpic(8) ceilpic(8) light(2) special(2) tag(2)=26
const sec = readLump('SECTORS');
const sectors = [];
for (let i = 0; i + 26 <= sec.size; i += 26) {
  const str = (o) => {
    let s = ''; for (let k = 0; k < 8; k++) { const c = sec.buf[i + o + k]; if (!c) break; s += String.fromCharCode(c); } return s;
  };
  sectors.push({
    idx: sectors.length,
    floorh: sec.buf.readInt16LE(i), ceilh: sec.buf.readInt16LE(i + 2),
    floorpic: str(4), ceilpic: str(12),
    light: sec.buf.readInt16LE(i + 20),
  });
}

// LINEDEFS: v1(2) v2(2) flags(2) special(2) tag(2) right(2) left(2) = 14
const ld = readLump('LINEDEFS');
const linedefs = [];
for (let i = 0; i + 14 <= ld.size; i += 14) {
  linedefs.push({
    idx: linedefs.length,
    v1: ld.buf.readUInt16LE(i), v2: ld.buf.readUInt16LE(i + 2),
    flags: ld.buf.readUInt16LE(i + 4),
    special: ld.buf.readUInt16LE(i + 6),
    tag: ld.buf.readUInt16LE(i + 8),
    right: ld.buf.readUInt16LE(i + 10),  // 0xFFFF = none
    left: ld.buf.readUInt16LE(i + 12),
  });
}

console.log(`\ncounts: vertexes=${vertexes.length} linedefs=${linedefs.length} sidedefs=${sidedefs.length} sectors=${sectors.length}`);

// ── Player spawn ──
// THINGS: x(2) y(2) angle(2) type(2) flags(2) = 10. Player 1 start = type 1.
const th = readLump('THINGS');
let spawn = null;
for (let i = 0; i + 10 <= th.size; i += 10) {
  const type = th.buf.readUInt16LE(i + 6);
  if (type === 1) {
    spawn = { x: th.buf.readInt16LE(i), y: th.buf.readInt16LE(i + 2), angle: th.buf.readInt16LE(i + 4) };
    break;
  }
}
console.log('player1 spawn:', spawn);

// ── Find candidate walls facing the player to the NORTH ──
// Player faces +y (north, angle 90). A south-facing wall the player sees
// has its solid side toward -y. We want linedefs north of spawn, roughly
// east-west (|dy| small), within a reasonable x window around spawn x,
// and within ~600 units forward.
const out = [];
for (const l of linedefs) {
  const a = vertexes[l.v1], b = vertexes[l.v2];
  const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  // north of spawn, in front, within forward window
  if (midy <= spawn.y + 20) continue;
  if (midy > spawn.y + 900) continue;
  if (Math.abs(midx - spawn.x) > 700) continue;
  // roughly east-west (horizontal wall) => |dy| small relative to |dx|
  const horiz = Math.abs(dy) < Math.abs(dx) * 0.6;
  if (!horiz) continue;
  const rs = l.right === 0xffff ? null : sidedefs[l.right];
  const ls = l.left === 0xffff ? null : sidedefs[l.left];
  out.push({ l, a, b, midx, midy, len, dx, dy, rs, ls });
}
out.sort((p, q) => p.midy - q.midy);
console.log(`\n${out.length} candidate horizontal walls north of spawn (sorted by distance):`);
for (const c of out) {
  const rsec = c.rs ? sectors[c.rs.sector] : null;
  const lsec = c.ls ? sectors[c.ls.sector] : null;
  console.log(
    `LD${String(c.l.idx).padStart(3)} ` +
    `v1(${c.a.x},${c.a.y})→v2(${c.b.x},${c.b.y}) ` +
    `len=${c.len.toFixed(0)} midy=${c.midy} dx=${c.dx} dy=${c.dy} ` +
    `2sided=${c.ls ? 'Y' : 'N'} ` +
    `R[sd${c.l.right} sec${c.rs?.sector} mid='${c.rs?.middle}' up='${c.rs?.upper}' low='${c.rs?.lower}' f/c=${rsec?.floorh}/${rsec?.ceilh}] ` +
    (c.ls ? `L[sd${c.l.left} sec${c.ls.sector} mid='${c.ls.middle}' up='${c.ls.upper}' low='${c.ls.lower}' f/c=${lsec?.floorh}/${lsec?.ceilh}]` : '')
  );
}

// ── Topology dump around spawn: sectors + their bounding linedefs ──
console.log('\n=== SECTOR FLATS (near spawn) ===');
for (const id of [2,5,13,37,38,39,41]) {
  const s = sectors[id];
  console.log(`sec${id}: floor=${s.floorh} ceil=${s.ceilh} floorpic='${s.floorpic}' ceilpic='${s.ceilpic}' light=${s.light}`);
}

function linesForSector(secId) {
  const res = [];
  for (const l of linedefs) {
    const rs = l.right === 0xffff ? null : sidedefs[l.right];
    const ls = l.left  === 0xffff ? null : sidedefs[l.left];
    if ((rs && rs.sector === secId) || (ls && ls.sector === secId)) res.push({ l, rs, ls });
  }
  return res;
}

for (const secId of [37, 39]) {
  console.log(`\n=== LINEDEFS bounding sector ${secId} ===`);
  for (const { l, rs, ls } of linesForSector(secId)) {
    const a = vertexes[l.v1], b = vertexes[l.v2];
    const facing = rs && rs.sector === secId ? 'R(into)' : 'L(into)';
    console.log(
      `LD${String(l.idx).padStart(3)} v1(${a.x},${a.y})→v2(${b.x},${b.y}) ` +
      `${l.left===0xffff?'1sided':'2sided'} secOn=${facing} ` +
      `R[sec${rs?.sector} mid='${rs?.middle}' up='${rs?.upper}' low='${rs?.lower}']` +
      (ls?` L[sec${ls.sector} mid='${ls.middle}' up='${ls.upper}' low='${ls.lower}']`:'')
    );
  }
}
