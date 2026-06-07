// Decode a Doom sprite/patch lump from the embedded WAD to PNG(s).
//
//   node tools/sprite-export.mjs ARM2A0 [--scale 16]
//
// Writes doom-assets/sprites/<LUMP>.png  (1:1, with transparency) and
//        doom-assets/sprites/<LUMP>@<scale>x.png  (zoomed preview to eyeball).
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  loadWasm, readDirectory, findLump, decodePatch, encodePNG, upscale,
} from './doom-gfx.mjs';

const name = process.argv[2];
if (!name) {
  console.error('usage: node tools/sprite-export.mjs <LUMP> [--scale N]');
  process.exit(1);
}
const scaleArg = process.argv.indexOf('--scale');
const scale = scaleArg > 0 ? parseInt(process.argv[scaleArg + 1], 10) : 16;

const wasm = loadWasm();
const dir = readDirectory(wasm);
const lump = findLump(dir, name);
const img = decodePatch(wasm, lump);

const outDir = new URL('../doom-assets/sprites/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const base = new URL(`./${name}.png`, outDir);
const zoom = new URL(`./${name}@${scale}x.png`, outDir);

writeFileSync(base, encodePNG(img.width, img.height, img.rgba));
const up = upscale(img.width, img.height, img.rgba, scale);
writeFileSync(zoom, encodePNG(up.width, up.height, up.rgba));

console.log(`${name}: ${img.width}x${img.height}  offset(${img.leftOffset},${img.topOffset})  lump ${lump.size}B @ fileOfs ${lump.fileOfs}`);
console.log(`  wrote ${base.pathname}`);
console.log(`  wrote ${zoom.pathname}  (${scale}x preview)`);
