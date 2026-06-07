// Build the INTH armour-pickup sprite frames as direct pixel art (no
// downscaling — hand-authored so the monogram stays crisp at sprite size).
//   node tools/armor-logo.mjs
// Badge = amber rounded square; "IN" teal on top; bottom is a teal box with
// "TH" knocked out in amber. Writes ARM2A0/ARM2B0 PNGs (+ @16x previews).
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePNG, upscale } from './doom-gfx.mjs';

const BADGE = 17;        // badge is 17x17, centred in the 31x17 ARM2 grid
const SPRITE = { w: 31, h: 17 };

// 5x6 blocky glyphs ('#' = ink, '.' = leave background)
const G = {
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..'],
  H: ['#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
};

const FRAMES = [
  { lump: 'ARM1A0', amber: '#FFC803', teal: '#182D37' },
  { lump: 'ARM1B0', amber: '#faa20a', teal: '#134d5b' },
];

const hex = (h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];

const outDir = new URL('../doom-assets/sprites/', import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const f of FRAMES) {
  const [ar, ag, ab] = hex(f.amber);
  const [tr, tg, tb] = hex(f.teal);
  const rgba = new Uint8Array(SPRITE.w * SPRITE.h * 4);
  const ox = (SPRITE.w - BADGE) >> 1; // 7

  // badge-local helpers (x,y in 0..16) -> sprite pixel
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= BADGE || y >= BADGE) return;
    const o = (y * SPRITE.w + (x + ox)) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  };
  const stamp = (glyph, gx, gy, color) => {
    glyph.forEach((row, j) =>
      [...row].forEach((c, i) => { if (c === '#') put(gx + i, gy + j, color); }));
  };

  // 1. amber background over the whole badge
  for (let y = 0; y < BADGE; y++) for (let x = 0; x < BADGE; x++) put(x, y, [ar, ag, ab]);
  // 2. bottom teal box (rows 8..16, full width)
  for (let y = 8; y < BADGE; y++) for (let x = 0; x < BADGE; x++) put(x, y, [tr, tg, tb]);
  // 3. "IN" teal on the amber top half
  stamp(G.I, 2, 1, [tr, tg, tb]);
  stamp(G.N, 10, 1, [tr, tg, tb]);
  // 4. "TH" amber knocked out of the teal box
  stamp(G.T, 2, 10, [ar, ag, ab]);
  stamp(G.H, 10, 10, [ar, ag, ab]);
  // 5. round the 4 outer corners (transparent)
  for (const [cx, cy] of [[0, 0], [BADGE - 1, 0], [0, BADGE - 1], [BADGE - 1, BADGE - 1]]) {
    const o = (cy * SPRITE.w + (cx + ox)) * 4;
    rgba[o + 3] = 0;
  }

  writeFileSync(new URL(`./${f.lump}.png`, outDir), encodePNG(SPRITE.w, SPRITE.h, rgba));
  const up = upscale(SPRITE.w, SPRITE.h, rgba, 16);
  writeFileSync(new URL(`./${f.lump}@16x.png`, outDir), encodePNG(up.width, up.height, up.rgba));
  console.log(`${f.lump}: badge ${BADGE}x${BADGE} @ x+${ox} in ${SPRITE.w}x${SPRITE.h}`);
}
