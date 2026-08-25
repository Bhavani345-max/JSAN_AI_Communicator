// PNG encoding for bitmaps that pdf.js hands back as raw pixels.
//
// PowerPoint needs a real image file, and pdf.js gives us an untyped pixel
// buffer. Encoding it here keeps the conversion free of a native image
// dependency: PNG's required chunks are simple and zlib ships with Node.

import zlib from 'zlib';

// pdf.js ImageKind
export const GRAYSCALE_1BPP = 1;
export const RGB_24BPP = 2;
export const RGBA_32BPP = 3;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function asBuffer(pixels) {
  if (Buffer.isBuffer(pixels)) return pixels;
  return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

/**
 * Normalise a pdf.js bitmap to 8-bit RGBA.
 *
 * 1-bit greyscale is deliberately not handled: its bit polarity varies with how
 * the image was encoded, and guessing wrong yields a photo-negative on the
 * slide. Returning null lets the caller skip the image and say so.
 */
export function toRgba({ width, height, kind, data }) {
  if (!width || !height || !data) return null;
  const src = asBuffer(data);
  const pixels = width * height;

  if (kind === RGBA_32BPP) {
    return src.length >= pixels * 4 ? src.subarray(0, pixels * 4) : null;
  }
  if (kind === RGB_24BPP) {
    if (src.length < pixels * 3) return null;
    const out = Buffer.alloc(pixels * 4);
    for (let i = 0, o = 0; i < pixels * 3; i += 3, o += 4) {
      out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = 255;
    }
    return out;
  }
  return null;
}

/** Encode 8-bit RGBA pixels as a PNG file. */
export function rgbaToPng(width, height, rgba) {
  const src = asBuffer(rgba);
  const stride = width * 4;
  // Each scanline is prefixed with its filter type; 0 means "no filtering",
  // which keeps this encoder simple and still compresses well through zlib.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const from = y * stride;
    src.copy(raw, y * (stride + 1) + 1, from, from + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
