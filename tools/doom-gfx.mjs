// Shared helpers for round-tripping Doom sprite/patch lumps <-> PNG.
//
// Doom "picture format" (a patch lump):
//   header: width(2) height(2) leftoffset(2) topoffset(2)   [all int16 LE]
//   then `width` * int32 LE column offsets (relative to lump start)
//   then, at each column offset, a run of "posts":
//       topdelta(1)  length(1)  padbyte(1)  length*pixel  padbyte(1)
//     repeated; a topdelta of 0xFF ends the column.
//   pixels are indices into the 256-colour Doom VGA palette.
//   gaps between posts are transparent.
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { DOOM_PALETTE, WAD_EMBEDDED_OFFSET } from '../doom-assets/doom-meta.js';

const WASM_PATH = new URL('../doom-assets/doom.wasm', import.meta.url);

// ── WAD directory access (reads the IWAD embedded in doom.wasm) ───────────
export function loadWasm() {
  return readFileSync(WASM_PATH);
}

export function readDirectory(wasm, base = WAD_EMBEDDED_OFFSET) {
  const magic = wasm.toString('ascii', base, base + 4);
  if (magic !== 'IWAD' && magic !== 'PWAD') {
    throw new Error(`no WAD magic at offset ${base} (got "${magic}")`);
  }
  const numLumps = wasm.readInt32LE(base + 4);
  const dirOfs = wasm.readInt32LE(base + 8);
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
    // `fileOfs` is the absolute byte offset of the lump inside the .wasm.
    dir.push({ index: i, name, fileOfs: base + ofs, size });
  }
  return dir;
}

export function findLump(dir, name) {
  const want = name.toUpperCase();
  const l = dir.find((d) => d.name === want);
  if (!l) throw new Error(`lump "${name}" not found in WAD`);
  return l;
}

// ── Doom patch  ->  {width,height,leftOffset,topOffset, rgba:Uint8Array} ──
// rgba is width*height*4, alpha 0 where the patch is transparent.
export function decodePatch(wasm, lump) {
  const b = wasm.subarray(lump.fileOfs, lump.fileOfs + lump.size);
  const width = b.readInt16LE(0);
  const height = b.readInt16LE(2);
  const leftOffset = b.readInt16LE(4);
  const topOffset = b.readInt16LE(6);
  const rgba = new Uint8Array(width * height * 4); // all transparent black
  for (let x = 0; x < width; x++) {
    let post = b.readInt32LE(8 + x * 4);
    while (b[post] !== 0xff) {
      const topdelta = b[post];
      const len = b[post + 1];
      let src = post + 3; // skip topdelta, len, pad byte
      for (let i = 0; i < len; i++) {
        const y = topdelta + i;
        const palIdx = b[src++];
        const o = (y * width + x) * 4;
        rgba[o] = DOOM_PALETTE[palIdx * 3];
        rgba[o + 1] = DOOM_PALETTE[palIdx * 3 + 1];
        rgba[o + 2] = DOOM_PALETTE[palIdx * 3 + 2];
        rgba[o + 3] = 255;
      }
      post = src + 1; // skip trailing pad byte -> next post / terminator
    }
  }
  return { width, height, leftOffset, topOffset, rgba };
}

// nearest palette index for an (r,g,b); plain squared-distance search.
// Index 0 is fair game — transparency is carried by alpha, not a key colour.
export function nearestPaletteIndex(r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = r - DOOM_PALETTE[i * 3];
    const dg = g - DOOM_PALETTE[i * 3 + 1];
    const db = b - DOOM_PALETTE[i * 3 + 2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ── {width,height,leftOffset,topOffset, rgba}  ->  Doom patch bytes ──────
// Pixels with alpha < `alphaThreshold` become transparent (no post).
export function encodePatch(img, alphaThreshold = 128) {
  const { width, height, leftOffset, topOffset, rgba } = img;
  const header = Buffer.alloc(8);
  header.writeInt16LE(width, 0);
  header.writeInt16LE(height, 2);
  header.writeInt16LE(leftOffset, 4);
  header.writeInt16LE(topOffset, 6);

  const colOfsTable = Buffer.alloc(width * 4);
  const columns = [];
  let cursor = 8 + width * 4; // pixel data starts after header + offset table

  for (let x = 0; x < width; x++) {
    colOfsTable.writeInt32LE(cursor, x * 4);
    const bytes = [];
    let y = 0;
    while (y < height) {
      // skip transparent rows
      while (y < height && rgba[(y * width + x) * 4 + 3] < alphaThreshold) y++;
      if (y >= height) break;
      const topdelta = y;
      const run = [];
      // Doom posts cap a topdelta+length at <=254; split very tall runs.
      while (
        y < height &&
        rgba[(y * width + x) * 4 + 3] >= alphaThreshold &&
        run.length < 254 &&
        topdelta + run.length < 254
      ) {
        const o = (y * width + x) * 4;
        run.push(nearestPaletteIndex(rgba[o], rgba[o + 1], rgba[o + 2]));
        y++;
      }
      bytes.push(topdelta, run.length, run[0] /*top pad = first pixel*/);
      for (const p of run) bytes.push(p);
      bytes.push(run[run.length - 1]); // bottom pad = last pixel
    }
    bytes.push(0xff); // column terminator
    const buf = Buffer.from(bytes);
    columns.push(buf);
    cursor += buf.length;
  }
  return Buffer.concat([header, colOfsTable, ...columns]);
}

// ── Minimal PNG encode (8-bit RGBA, no interlace, filter 0) ──────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
export function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4)
      .forEach((v, i) => (raw[y * (width * 4 + 1) + 1 + i] = v));
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Minimal PNG decode -> {width,height,rgba} ────────────────────────────
// Handles 8-bit colour types 2 (RGB), 6 (RGBA), 3 (palette), non-interlaced.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
  if (interlace) throw new Error('interlaced PNG not supported — re-export non-interlaced');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      line[i] = v & 0xff;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  // expand to RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 6) {
      rgba[i * 4] = out[i * 4];
      rgba[i * 4 + 1] = out[i * 4 + 1];
      rgba[i * 4 + 2] = out[i * 4 + 2];
      rgba[i * 4 + 3] = out[i * 4 + 3];
    } else if (colorType === 2) {
      rgba[i * 4] = out[i * 3];
      rgba[i * 4 + 1] = out[i * 3 + 1];
      rgba[i * 4 + 2] = out[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else {
      const idx = out[i];
      rgba[i * 4] = plte[idx * 3];
      rgba[i * 4 + 1] = plte[idx * 3 + 1];
      rgba[i * 4 + 2] = plte[idx * 3 + 2];
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// nearest-neighbour upscale of an RGBA buffer (for zoomed previews).
export function upscale(width, height, rgba, scale) {
  const W = width * scale, H = height * scale;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (((y / scale) | 0) * width + ((x / scale) | 0)) * 4;
      const d = (y * W + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  return { width: W, height: H, rgba: out };
}
