'use strict';
// Minimal PNG reader/writer using Node's built-in zlib.
// Supports 8-bit grayscale (type 0), RGB (type 2), RGBA (type 6),
// with all five standard filter types. No interlace support.

const zlib = require('zlib');
const { Image } = require('./image');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPNG(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels; // bytes per pixel at 8-bit
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rpos = 0;
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[rpos++];
    const lineStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rpos++];
      // Per PNG spec: Sub and Paeth reference the byte bpp positions to the
      // left; Up and Average reference the byte directly above. Average's
      // left term is the pixel to the left (x - bpp), not the previous byte.
      const a = x >= bpp ? out[lineStart + x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: v = rawByte + paethPredictor(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      out[lineStart + x] = v & 255;
    }
    out.copy(prev, 0, lineStart, lineStart + stride);
  }
  const outChannels = colorType === 6 ? 3 : channels;
  const img = new Image(width, height, outChannels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * channels;
      const di = y * width + x;
      if (colorType === 0) {
        img.planes[0][di] = out[si];
      } else if (colorType === 2) {
        img.planes[0][di] = out[si];
        img.planes[1][di] = out[si + 1];
        img.planes[2][di] = out[si + 2];
      } else {
        // Composite RGBA over white background.
        const alpha = out[si + 3] / 255;
        for (let c = 0; c < 3; c++) {
          img.planes[c][di] = out[si + c] * alpha + 255 * (1 - alpha);
        }
      }
    }
  }
  return img;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function writePNG(img) {
  const w = img.width, h = img.height, ch = img.channels;
  const bpp = ch; // bytes per pixel
  const stride = w * bpp;
  const raw = Buffer.alloc(h * (stride + 1));
  let rp = 0;
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let v = img.planes[c][y * w + x];
        if (v < 0) v = 0; else if (v > 255) v = 255;
        line[x * ch + c] = Math.round(v);
      }
    }
    // Adaptive filter selection: choose per-row filter minimizing sum of
    // absolute bytes. Sub/Paeth/Average all use the pixel at x - bpp as the
    // left reference because filtering is done independently per byte of a
    // pixel, using the reconstructed previous byte *of the same pixel*.
    const candidates = [];
    for (let f = 0; f < 5; f++) {
      const buf = Buffer.alloc(stride);      // filtered (stored) bytes
      const recon = Buffer.alloc(stride);    // reconstructed pixel bytes
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? recon[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let pred;
        switch (f) {
          case 0: pred = 0; break;
          case 1: pred = a; break;
          case 2: pred = b; break;
          case 3: pred = (a + b) >> 1; break;
          default: pred = paethPredictor(a, b, c);
        }
        const d = (line[x] - pred) & 255;
        buf[x] = d;
        recon[x] = (d + pred) & 255;
        cost += d < 128 ? d : 256 - d;
      }
      candidates.push({ f, buf, recon, cost });
    }
    candidates.sort((p, q) => p.cost - q.cost);
    const best = candidates[0];
    raw[rp++] = best.f;
    best.buf.copy(raw, rp);
    rp += stride;
    // Reconstructed bytes become the predictor state for the next row.
    best.recon.copy(prev);
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });
  const chunks = [];
  chunks.push(Buffer.from(PNG_SIGNATURE));
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
    chunks.push(len, typeBuf, data, crcBuf);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 1 ? 0 : 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', compressed);
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { readPNG, writePNG };
