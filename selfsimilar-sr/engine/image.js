'use strict';
// Minimal zero-dependency image container and resampling / colour utilities.
// Pixels are stored as planar Float64 arrays, values in [0, 255].

class Image {
  constructor(width, height, channels = 3) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.planes = [];
    for (let c = 0; c < channels; c++) {
      this.planes.push(new Float64Array(width * height));
    }
  }

  static fromPlanar(width, height, planes) {
    const img = new Image(width, height, planes.length);
    for (let c = 0; c < planes.length; c++) img.planes[c] = planes[c];
    return img;
  }

  get channel() {
    return this.channels === 1 ? this.planes[0] : null;
  }

  get(x, y, c = 0) {
    if (x < 0) x = 0; else if (x >= this.width) x = this.width - 1;
    if (y < 0) y = 0; else if (y >= this.height) y = this.height - 1;
    return this.planes[c][y * this.width + x];
  }

  set(x, y, c, v) {
    this.planes[c][y * this.width + x] = v;
  }

  clone() {
    const img = new Image(this.width, this.height, this.channels);
    for (let c = 0; c < this.channels; c++) img.planes[c].set(this.planes[c]);
    return img;
  }

  subImage(x0, y0, w, h) {
    const out = new Image(w, h, this.channels);
    for (let c = 0; c < this.channels; c++) {
      const src = this.planes[c], dst = out.planes[c];
      for (let y = 0; y < h; y++) {
        const sy = Math.min(this.height - 1, Math.max(0, y0 + y));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(this.width - 1, Math.max(0, x0 + x));
          dst[y * w + x] = src[sy * this.width + sx];
        }
      }
    }
    return out;
  }
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clipCopy(img) {
  const out = new Image(img.width, img.height, img.channels);
  for (let c = 0; c < img.channels; c++) {
    const s = img.planes[c], d = out.planes[c];
    for (let i = 0; i < s.length; i++) d[i] = clamp255(s[i]);
  }
  return out;
}

// ---------------- RGB <-> YCbCr (BT.601, full-range) ----------------

function rgbToYCbCr(img) {
  const out = new Image(img.width, img.height, 3);
  const [r, g, b] = img.planes;
  const [y, cb, cr] = out.planes;
  for (let i = 0; i < y.length; i++) {
    const R = r[i], G = g[i], B = b[i];
    y[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    cb[i] = 128 + (-0.168736 * R - 0.331264 * G + 0.5 * B);
    cr[i] = 128 + (0.5 * R - 0.418688 * G - 0.081312 * B);
  }
  return out;
}

function yCbCrToRGB(img) {
  const out = new Image(img.width, img.height, 3);
  const [y, cb, cr] = img.planes;
  const [r, g, b] = out.planes;
  for (let i = 0; i < y.length; i++) {
    const Y = y[i], Cb = cb[i] - 128, Cr = cr[i] - 128;
    r[i] = clamp255(Y + 1.402 * Cr);
    g[i] = clamp255(Y - 0.344136 * Cb - 0.714136 * Cr);
    b[i] = clamp255(Y + 1.772 * Cb);
  }
  return out;
}

// ---------------- Bicubic resampling (Catmull-Rom, a = -0.5) ----------------

function cubicKernel(t) {
    const a = -0.5;
    const x = Math.abs(t);
    if (x <= 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
    if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
    return 0;
}

function resampleChannel(src, sw, sh, dw, dh) {
  const dst = new Float64Array(dw * dh);
  // Coordinate mapping: output pixel centres aligned via (x+0.5)*sw/dw - 0.5
  const xs = new Float64Array(dw);
  const xw = [];
  for (let x = 0; x < dw; x++) {
    const cx = (x + 0.5) * sw / dw - 0.5;
    const x0 = Math.floor(cx);
    const weights = [];
    let wsum = 0;
    for (let k = -1; k <= 2; k++) {
      const w = cubicKernel(cx - (x0 + k));
      weights.push([x0 + k, w]);
      wsum += w;
    }
    if (wsum !== 0) for (const w of weights) w[1] /= wsum;
    xs[x] = x0;
    xw.push(weights);
  }
  const tmp = new Float64Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (const [sx, w] of xw[x]) {
        const cx = sx < 0 ? 0 : sx >= sw ? sw - 1 : sx;
        acc += w * src[y * sw + cx];
      }
      tmp[y * dw + x] = acc;
    }
  }
  const ys = new Float64Array(dh);
  const yw = [];
  for (let y = 0; y < dh; y++) {
    const cy = (y + 0.5) * sh / dh - 0.5;
    const y0 = Math.floor(cy);
    const weights = [];
    let wsum = 0;
    for (let k = -1; k <= 2; k++) {
      const w = cubicKernel(cy - (y0 + k));
      weights.push([y0 + k, w]);
      wsum += w;
    }
    if (wsum !== 0) for (const w of weights) w[1] /= wsum;
    ys[y] = y0;
    yw.push(weights);
  }
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (const [sy, w] of yw[y]) {
        const cyy = sy < 0 ? 0 : sy >= sh ? sh - 1 : sy;
        acc += w * tmp[cyy * dw + x];
      }
      dst[y * dw + x] = acc;
    }
  }
  return dst;
}

function resample(img, newW, newH) {
  const out = new Image(newW, newH, img.channels);
  for (let c = 0; c < img.channels; c++) {
    out.planes[c] = resampleChannel(img.planes[c], img.width, img.height, newW, newH);
  }
  return out;
}

// Separable Gaussian blur (kernel radius from sigma, edge clamp).
function gaussianBlurChannel(src, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kern = new Float64Array(2 * radius + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kern[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kern.length; i++) kern[i] /= ksum;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        acc += kern[k + radius] * src[y * w + xx];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        acc += kern[k + radius] * tmp[yy * w + x];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// Known forward degradation model: Gaussian blur (sigma) then bicubic downscale.
function degrade(img, scale, sigma) {
  const blurred = new Image(img.width, img.height, img.channels);
  for (let c = 0; c < img.channels; c++) {
    blurred.planes[c] = gaussianBlurChannel(img.planes[c], img.width, img.height, sigma);
  }
  const dw = Math.max(1, Math.round(img.width / scale));
  const dh = Math.max(1, Math.round(img.height / scale));
  return resample(blurred, dw, dh);
}

module.exports = {
  Image,
  clamp255,
  clipCopy,
  rgbToYCbCr,
  yCbCrToRGB,
  resample,
  resampleChannel,
  gaussianBlurChannel,
  degrade,
};
