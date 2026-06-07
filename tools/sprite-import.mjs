// Encode a PNG back into a Doom sprite/patch lump, in-place inside doom.wasm.
//
//   node tools/sprite-import.mjs ARM2A0 ARM2B0 --src logo.png
//
// - One or more LUMP names; the new bytes are written at each lump's offset.
// - --src <png>   PNG to use for ALL named lumps (default: doom-assets/sprites/<LUMP>.png each)
// - --offx/--offy override the sprite's draw offset (default: keep original)
// - --dry         report sizes, write nothing
//
// Constraint: the re-encoded lump must be <= the original lump size (it is
// spliced in place and zero-padded; the WAD directory entry is untouched).
// Doom reads via the column-offset table + posts, so trailing padding is
// ignored. A recolour/logo at the original dimensions virtually always fits.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import {
  loadWasm, readDirectory, findLump, decodePNG, encodePatch,
} from './doom-gfx.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes('--dry');
const srcOverride = flag('--src');
const offx = flag('--offx');
const offy = flag('--offy');
const lumps = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--src' &&
  args[i - 1] !== '--offx' && args[i - 1] !== '--offy');

if (!lumps.length) {
  console.error('usage: node tools/sprite-import.mjs <LUMP> [LUMP...] [--src png] [--offx N] [--offy N] [--dry]');
  process.exit(1);
}

const wasmUrl = new URL('../doom-assets/doom.wasm', import.meta.url);
const wasm = loadWasm();
const dir = readDirectory(wasm);

const edits = [];
for (const name of lumps) {
  const lump = findLump(dir, name);
  const srcPath = srcOverride
    ? new URL(srcOverride, `file://${process.cwd()}/`)
    : new URL(`../doom-assets/sprites/${name}.png`, import.meta.url);
  if (!existsSync(srcPath)) throw new Error(`source PNG not found: ${srcPath.pathname}`);
  const png = decodePNG(readFileSync(srcPath));

  // Original header offsets (so we keep the pickup anchored like vanilla).
  const ob = wasm.subarray(lump.fileOfs, lump.fileOfs + 8);
  const origLeft = ob.readInt16LE(4);
  const origTop = ob.readInt16LE(6);

  const img = {
    width: png.width,
    height: png.height,
    leftOffset: offx !== undefined ? parseInt(offx, 10)
      : (png.width === wasm.readInt16LE(lump.fileOfs) ? origLeft : png.width >> 1),
    topOffset: offy !== undefined ? parseInt(offy, 10)
      : (png.height === wasm.readInt16LE(lump.fileOfs + 2) ? origTop : png.height),
    rgba: png.rgba,
  };
  const bytes = encodePatch(img);
  edits.push({ name, lump, bytes, png });
  const fits = bytes.length <= lump.size;
  console.log(
    `${name}: ${png.width}x${png.height} off(${img.leftOffset},${img.topOffset}) ` +
    `-> ${bytes.length}B (slot ${lump.size}B) ${fits ? 'OK' : 'TOO BIG ✗'}`,
  );
  if (!fits) {
    throw new Error(
      `${name}: re-encoded ${bytes.length}B exceeds original ${lump.size}B slot. ` +
      `Reduce detail/colours, or we switch to the WAD-rebuild path.`,
    );
  }
}

if (dry) {
  console.log('\n--dry: nothing written.');
  process.exit(0);
}

// Back up once, then splice each lump in place + zero-pad to its slot length.
const bak = new URL('../doom-assets/doom.wasm.bak', import.meta.url);
if (!existsSync(bak)) {
  copyFileSync(wasmUrl, bak);
  console.log(`\nbacked up original -> ${bak.pathname}`);
}
for (const { lump, bytes } of edits) {
  bytes.copy(wasm, lump.fileOfs);
  wasm.fill(0, lump.fileOfs + bytes.length, lump.fileOfs + lump.size);
}
writeFileSync(wasmUrl, wasm);
console.log(`wrote ${edits.length} lump(s) into ${wasmUrl.pathname}`);
console.log('Reload the page (hard refresh) to see the change.');
