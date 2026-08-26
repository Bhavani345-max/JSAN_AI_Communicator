#!/usr/bin/env node
// JSAN Dev AI — browser icons.
//
//   npm run icons        (from portal/frontend)
//
// Writes public/favicon.ico, public/favicon.svg and public/apple-touch-icon.png
// from one description of the JSAN mark, so the vector and the raster versions
// cannot drift apart.
//
// The mark is the bracket on the left of public/jsan-logo.png, measured off
// that file: the wordmark beside it is 172x56 and unreadable below about 64
// pixels, so a favicon built from the whole logo would be a grey smudge in the
// tab. The bracket alone stays legible at 16.
//
// The PNG and ICO files are written by hand rather than with a rendering
// library, because the portal has no image dependency and this is four
// rectangles and a rounded corner - not enough to justify one. Coverage is sampled 4x4 per pixel and
// averaged, which is what keeps the corners and edges from being jagged.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// The blue in the logo file itself, not the lighter --jsan-blue the interface
// uses for buttons: this has to look like the logo, not like the UI.
const BLUE = { r: 0x02, g: 0x54, b: 0x8c, hex: '#02548c' };
const WHITE = { r: 0xff, g: 0xff, b: 0xff };

// Design space is 64x64. The tile is the full square with rounded corners; the
// mark sits inside it with even padding.
const SIZE = 64;
const RADIUS = 14;

// The mark, in its own 49x48 box, as measured from the logo. Four rectangles
// whose union is two nested corner brackets - top-left, then bottom-right.
const MARK_W = 49, MARK_H = 48;
const MARK_RECTS = [
  { x: 0,  y: 0,  w: 49, h: 11 },  // top bar
  { x: 0,  y: 0,  w: 11, h: 48 },  // left column
  { x: 38, y: 21, w: 11, h: 27 },  // right stub
  { x: 20, y: 38, w: 29, h: 10 }   // bottom bar
];
const MARK_SCALE = 0.75;
const MARK_DX = (SIZE - MARK_W * MARK_SCALE) / 2;
const MARK_DY = (SIZE - MARK_H * MARK_SCALE) / 2;

/** Is this point inside the rounded tile? */
function inTile(x, y) {
  if (x < 0 || y < 0 || x > SIZE || y > SIZE) return false;
  // Only the four corner boxes can fall outside, so the rest is a plain hit.
  const cx = x < RADIUS ? RADIUS : (x > SIZE - RADIUS ? SIZE - RADIUS : null);
  const cy = y < RADIUS ? RADIUS : (y > SIZE - RADIUS ? SIZE - RADIUS : null);
  if (cx === null || cy === null) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
}

/** Is this point inside the mark? */
function inMark(x, y) {
  const mx = (x - MARK_DX) / MARK_SCALE;
  const my = (y - MARK_DY) / MARK_SCALE;
  return MARK_RECTS.some(r => mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h);
}

// --- SVG -------------------------------------------------------------------

function buildSvg() {
  const rects = MARK_RECTS
    .map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="JSAN">
  <title>JSAN Dev AI</title>
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="${BLUE.hex}"/>
  <g fill="#ffffff" transform="translate(${round(MARK_DX)} ${round(MARK_DY)}) scale(${MARK_SCALE})">${rects}</g>
</svg>
`;
}

const round = (value) => Number(value.toFixed(3));

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * The icon at `size`, as top-down RGBA pixels.
 *
 * SAMPLES x SAMPLES points per pixel, averaged. Straight averaging of coverage
 * is only correct because the two colours are composited in the right order:
 * the mark's white is laid over the tile's blue first, and the result is then
 * faded out by how much of the pixel the tile covers. Averaging the final
 * colour and the alpha separately would fringe the outer corners with white.
 */
function renderRgba(size) {
  const SAMPLES = 4;
  const scale = SIZE / size;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0, mark = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (!inTile(x, y)) continue;
          tile++;
          if (inMark(x, y)) mark++;
        }
      }
      const at = (py * size + px) * 4;
      if (tile === 0) continue; // already transparent black
      const white = mark / tile;
      const mix = (channel) => Math.round(BLUE[channel] + (WHITE[channel] - BLUE[channel]) * white);
      pixels[at] = mix('r');
      pixels[at + 1] = mix('g');
      pixels[at + 2] = mix('b');
      pixels[at + 3] = Math.round((tile / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

/** Wrap rendered pixels as a PNG. */
function encodePng(size, pixels) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let py = 0; py < size; py++) {
    raw[py * stride] = 0; // filter type: none
    pixels.copy(raw, py * stride + 1, py * size * 4, (py + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const renderPng = (size) => encodePng(size, renderRgba(size));

/**
 * Pack several sizes into one .ico.
 *
 * Written as classic 32-bit BMP images rather than the PNG-in-ICO that modern
 * encoders emit. Both are legal and every current browser reads either, but a
 * favicon is exactly the file that gets fetched by the oldest thing on the
 * network - a crawler, a link unfurler, a chat client's preview fetcher - and
 * BMP is the one all of them have always understood.
 *
 * Two quirks of the format worth knowing before editing this: the height in
 * the header is doubled because the image is stored as colour data followed by
 * a 1-bit transparency mask, and rows run bottom-up. The mask is redundant
 * beside a real alpha channel, but it has to be there and has to be the right
 * size, so it is written from the alpha rather than left as zeroes.
 */
function encodeIco(sizes) {
  const images = sizes.map(size => {
    const pixels = renderRgba(size);
    const xorStride = size * 4;
    const andStride = Math.ceil(size / 8 / 4) * 4;
    const xor = Buffer.alloc(size * xorStride);
    const and = Buffer.alloc(size * andStride);
    for (let py = 0; py < size; py++) {
      const row = size - 1 - py; // bottom-up
      for (let px = 0; px < size; px++) {
        const from = (py * size + px) * 4;
        const to = row * xorStride + px * 4;
        xor[to] = pixels[from + 2];      // B
        xor[to + 1] = pixels[from + 1];  // G
        xor[to + 2] = pixels[from];      // R
        xor[to + 3] = pixels[from + 3];  // A
        // A set bit means "leave what is behind this pixel alone".
        if (pixels[from + 3] === 0) and[row * andStride + (px >> 3)] |= 0x80 >> (px & 7);
      }
    }
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);            // biSize
    header.writeInt32LE(size, 4);           // biWidth
    header.writeInt32LE(size * 2, 8);       // biHeight: colour data plus mask
    header.writeUInt16LE(1, 12);            // biPlanes
    header.writeUInt16LE(32, 14);           // biBitCount
    header.writeUInt32LE(0, 16);            // biCompression: none
    header.writeUInt32LE(xor.length + and.length, 20); // biSizeImage
    return { size, body: Buffer.concat([header, xor, and]) };
  });

  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);                  // reserved
  dir.writeUInt16LE(1, 2);                  // type: icon
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    dir[at] = image.size === 256 ? 0 : image.size;     // 0 means 256
    dir[at + 1] = image.size === 256 ? 0 : image.size;
    dir[at + 2] = 0;                        // palette size: not paletted
    dir[at + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, at + 4);           // planes
    dir.writeUInt16LE(32, at + 6);          // bits per pixel
    dir.writeUInt32LE(image.body.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += image.body.length;
  });
  return Buffer.concat([dir, ...images.map(image => image.body)]);
}

// --- Write -----------------------------------------------------------------

const written = [
  // Every browser asks for /favicon.ico whether or not the page links to one,
  // and so does anything that unfurls a link. Without this file that request
  // reaches the single-page fallback and is answered with index.html - a 200
  // carrying HTML under an .ico name, which is read as a broken icon and then
  // cached as one. It is first in the list for the same reason.
  ['favicon.ico', encodeIco([16, 32, 48])],
  ['favicon.svg', Buffer.from(buildSvg(), 'utf8')],
  // Home-screen icon on iOS, which crops to its own rounded shape - so the
  // mark's padding inside the tile is what keeps it from being clipped.
  ['apple-touch-icon.png', renderPng(180)]
];

for (const [name, bytes] of written) {
  fs.writeFileSync(path.join(PUBLIC_DIR, name), bytes);
  console.log(`${name.padEnd(22)} ${(bytes.length / 1024).toFixed(1)} KB`);
}
