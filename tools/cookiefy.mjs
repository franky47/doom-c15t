// Turn every enemy into a cookie. Replaces all sprite frames of each monster
// type in the embedded WAD with a procedurally-drawn chocolate-chip cookie,
// sized per-frame to the original frame's footprint and shrunk to fit the
// lump's byte slot (in-place splice, same constraint as sprite-import).
//   node tools/cookiefy.mjs [--dry]
import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadWasm, readDirectory, encodePatch } from './doom-gfx.mjs';

export const PREFIXES = ['POSS', 'SPOS', 'TROO', 'SARG', 'BOSS']; // enemies in the shareware WAD

// Cookie palette (RGB; quantised to the Doom palette on encode).
const BODY = [227, 190, 131];      // pale dough
const BODY_DARK = [210, 164, 97];  // gentle mid shade
const RIM = [176, 124, 61];        // edge definition
const CHIP = [62, 36, 18];         // dark chocolate

const CHIP_COUNT = 7;              // few, scattered chips

// Deterministic per-seed RNG so a monster type's cookie is stable across all
// its frames but differs between types.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Scatter CHIP_COUNT chips inside the disc (fractional box coords + radius),
// rejection-sampled for a min spacing so they read as random-but-not-clumped.
export function chipLayout(seed) {
  const rng = mulberry32(seed);
  const chips = [];
  const minDist = 0.24;
  for (let tries = 0; tries < 800 && chips.length < CHIP_COUNT; tries++) {
    const rho = Math.sqrt(rng()) * 0.78;   // uniform over area, kept off the rim
    const ang = rng() * Math.PI * 2;
    const fx = 0.5 + 0.5 * rho * Math.cos(ang);
    const fy = 0.5 + 0.5 * rho * Math.sin(ang);
    if (chips.every((c) => Math.hypot(c.fx - fx, c.fy - fy) > minDist)) {
      chips.push({ fx, fy, rr: 0.05 + rng() * 0.025 }); // slight size variation
    }
  }
  return chips;
}

// Draw a DxD cookie into an RGBA buffer (transparent outside the disc).
function cookie(D, chips) {
  const rgba = new Uint8Array(D * D * 4);
  const c = (D - 1) / 2;
  const r = D / 2 - 0.5;
  const set = (x, y, [cr, cg, cb]) => {
    const o = (y * D + x) * 4;
    rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb; rgba[o + 3] = 255;
  };
  for (let y = 0; y < D; y++)
    for (let x = 0; x < D; x++) {
      const d = Math.hypot(x - c, y - c) / r;
      if (d > 1) continue;
      set(x, y, d > 0.9 ? RIM : d > 0.72 ? BODY_DARK : BODY);
    }
  for (const { fx, fy, rr } of chips) {
    const cx = fx * (D - 1), cy = fy * (D - 1);
    const chipR = Math.max(1, Math.round(rr * D));
    for (let y = 0; y < D; y++)
      for (let x = 0; x < D; x++) {
        if (Math.hypot(x - c, y - c) / r > 0.92) continue; // keep chips inside rim
        if (Math.hypot(x - cx, y - cy) <= chipR) set(x, y, CHIP);
      }
  }
  return rgba;
}

export function buildPatch(D, chips) {
  return encodePatch({
    width: D, height: D,
    leftOffset: D >> 1, topOffset: D, // bottom-centre: cookie rests on the floor
    rgba: cookie(D, chips),
  });
}

function main() {
  const DRY = process.argv.includes('--dry');
  const wasmUrl = new URL('../doom-assets/doom.wasm', import.meta.url);
  const wasm = loadWasm();
  const dir = readDirectory(wasm);
  const s0 = dir.findIndex((d) => d.name === 'S_START');
  const s1 = dir.findIndex((d) => d.name === 'S_END');

  const targets = dir.filter((d) =>
    d.index > s0 && d.index < s1 && PREFIXES.includes(d.name.slice(0, 4)));

  // One chip layout per monster type (stable across all its frames).
  const layoutByPrefix = new Map();
  for (const p of PREFIXES) layoutByPrefix.set(p, chipLayout(hashSeed(p)));

  let written = 0, shrunk = 0;
  const edits = [];
  for (const lump of targets) {
    const chips = layoutByPrefix.get(lump.name.slice(0, 4));
    const origH = wasm.readInt16LE(lump.fileOfs + 2);
    let D = Math.max(10, Math.round(origH * 0.8)); // cookie ≈ 80% of frame height
    let bytes = buildPatch(D, chips);
    while (bytes.length > lump.size && D > 8) { D -= 1; bytes = buildPatch(D, chips); shrunk++; }
    if (bytes.length > lump.size) {
      throw new Error(`${lump.name}: cookie ${bytes.length}B won't fit ${lump.size}B even at D=${D}`);
    }
    edits.push({ lump, bytes, D });
    written++;
  }

  console.log(`${written} enemy frames -> cookies (${shrunk} shrink steps). ` +
    `D range ${Math.min(...edits.map(e => e.D))}..${Math.max(...edits.map(e => e.D))}px`);

  if (DRY) { console.log('--dry: nothing written.'); return; }

  const bak = new URL('../doom-assets/doom.wasm.bak', import.meta.url);
  if (!existsSync(bak)) { copyFileSync(wasmUrl, bak); console.log(`backed up -> ${bak.pathname}`); }
  for (const { lump, bytes } of edits) {
    bytes.copy(wasm, lump.fileOfs);
    wasm.fill(0, lump.fileOfs + bytes.length, lump.fileOfs + lump.size);
  }
  writeFileSync(wasmUrl, wasm);
  console.log(`wrote ${written} lumps into ${wasmUrl.pathname}. Hard-refresh to see the cookies.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
