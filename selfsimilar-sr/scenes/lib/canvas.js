'use strict';
// Tiny deterministic vector rasterizer used to draw the reference scenes.
//
// Everything is rendered on a supersampled RGBA float buffer and box-filtered
// down, so primitives are anti-aliased without any external image library.
// Shapes are axis-aligned rectangles, thick line segments / polylines,
// circles, polygons and a few procedural texture fills. All coordinates are
// in reference (output) pixels; the supersample factor comes from the scene.

const { Image } = require('../../engine/image');

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class Canvas {
  constructor(width, height, supersample, background) {
    this.width = width;
    this.height = height;
    this.ss = supersample;
    this.rw = width * supersample;
    this.rh = height * supersample;
    const n = this.rw * this.rh;
    this.r = new Float64Array(n);
    this.g = new Float64Array(n);
    this.b = new Float64Array(n);
    this.a = new Float64Array(n);
    const [br, bg, bb] = background;
    this.r.fill(br); this.g.fill(bg); this.b.fill(bb); this.a.fill(255);
  }

  _blend(i, color, alpha) {
    const a = clamp(alpha, 0, 1);
    if (a <= 0) return;
    const inv = 1 - a;
    this.r[i] = this.r[i] * inv + color[0] * a;
    this.g[i] = this.g[i] * inv + color[1] * a;
    this.b[i] = this.b[i] * inv + color[2] * a;
    this.a[i] = 255;
  }

  rect(x, y, w, h, color, alpha = 1) {
    const S = this.ss;
    const x0 = Math.max(0, Math.round(x * S));
    const y0 = Math.max(0, Math.round(y * S));
    const x1 = Math.min(this.rw, Math.round((x + w) * S));
    const y1 = Math.min(this.rh, Math.round((y + h) * S));
    for (let py = y0; py < y1; py++) {
      let i = py * this.rw + x0;
      for (let px = x0; px < x1; px++, i++) this._blend(i, color, alpha);
    }
  }

  // Rounded / flat thick segment with optional circular caps.
  segment(x1, y1, x2, y2, width, color, alpha = 1, round = true) {
    const S = this.ss;
    const rad = Math.max(width * S / 2, 0.5);
    const ax = x1 * S, ay = y1 * S, bx = x2 * S, by = y2 * S;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - rad - 1));
    const maxX = Math.min(this.rw - 1, Math.ceil(Math.max(ax, bx) + rad + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - rad - 1));
    const maxY = Math.min(this.rh - 1, Math.ceil(Math.max(ay, by) + rad + 1));
    const vx = bx - ax, vy = by - ay;
    const vv = vx * vx + vy * vy;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        let t = vv > 0 ? ((px - ax) * vx + (py - ay) * vy) / vv : 0;
        if (round) t = clamp(t, 0, 1);
        else t = clamp(t, 0, 1);
        const dx = px - (ax + t * vx);
        const dy = py - (ay + t * vy);
        const d = Math.hypot(dx, dy);
        // One-pixel soft coverage edge (already supersampled, so this is a
        // sub-pixel blend at the very rim).
        const cov = clamp(rad + 0.5 - d, 0, 1);
        if (cov > 0) this._blend(py * this.rw + px, color, alpha * cov);
      }
    }
  }

  polyline(points, width, color, alpha = 1) {
    for (let i = 0; i + 1 < points.length; i++) {
      this.segment(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1],
        width, color, alpha, true);
    }
  }

  circle(cx, cy, radius, color, alpha = 1) {
    const S = this.ss;
    const cxr = cx * S, cyr = cy * S, r = radius * S;
    const minX = Math.max(0, Math.floor(cxr - r - 1));
    const maxX = Math.min(this.rw - 1, Math.ceil(cxr + r + 1));
    const minY = Math.max(0, Math.floor(cyr - r - 1));
    const maxY = Math.min(this.rh - 1, Math.ceil(cyr + r + 1));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const d = Math.hypot(px - cxr, py - cyr);
        const cov = clamp(r + 0.5 - d, 0, 1);
        if (cov > 0) this._blend(py * this.rw + px, color, alpha * cov);
      }
    }
  }

  polygon(points, color, alpha = 1) {
    const S = this.ss;
    const scaled = points.map(([x, y]) => [x * S, y * S]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of scaled) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    minX = Math.max(0, Math.floor(minX)); maxX = Math.min(this.rw - 1, Math.ceil(maxX));
    minY = Math.max(0, Math.floor(minY)); maxY = Math.min(this.rh - 1, Math.ceil(maxY));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (pointInPolygon(px + 0.5, py + 0.5, scaled)) {
          this._blend(py * this.rw + px, color, alpha);
        }
      }
    }
  }

  // Smooth linear gradient across the full canvas. `axis` is 'x', 'y' or 'd'.
  gradient(from, to, axis = 'd') {
    for (let y = 0; y < this.rh; y++) {
      for (let x = 0; x < this.rw; x++) {
        let t;
        if (axis === 'x') t = x / (this.rw - 1);
        else if (axis === 'y') t = y / (this.rh - 1);
        else t = (x + y) / (this.rw + this.rh - 2);
        const i = y * this.rw + x;
        this.r[i] = from[0] + (to[0] - from[0]) * t;
        this.g[i] = from[1] + (to[1] - from[1]) * t;
        this.b[i] = from[2] + (to[2] - from[2]) * t;
        this.a[i] = 255;
      }
    }
  }

  // Procedural texture fill inside a rectangle. Patterns are computed from
  // the supersampled pixel coordinate, so they are deterministic and do not
  // depend on paint order.
  texture(x, y, w, h, pattern, opts = {}) {
    const S = this.ss;
    const { color = [60, 60, 60], background = null, spacing = 4, thickness = 1,
      amplitude = 40, angle = 0, seed = 1, coverage = 0.5 } = opts;
    const x0 = Math.max(0, Math.round(x * S));
    const y0 = Math.max(0, Math.round(y * S));
    const x1 = Math.min(this.rw, Math.round((x + w) * S));
    const y1 = Math.min(this.rh, Math.round((y + h) * S));
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = py * this.rw + px;
        const lx = px / S - x, ly = py / S - y;
        const u = lx * cos + ly * sin;
        const v = -lx * sin + ly * cos;
        let on = false;
        let shade = 0;
        if (pattern === 'stripes') {
          on = mod(u, spacing) < thickness;
        } else if (pattern === 'crosshatch') {
          on = mod(u, spacing) < thickness || mod(v, spacing) < thickness;
        } else if (pattern === 'dots') {
          const cx = Math.floor(lx / spacing), cy = Math.floor(ly / spacing);
          const ox = lx - (cx + 0.5) * spacing, oy = ly - (cy + 0.5) * spacing;
          on = Math.hypot(ox, oy) < Math.max(0.75, thickness);
        } else if (pattern === 'checker') {
          on = ((Math.floor(lx / spacing) + Math.floor(ly / spacing)) & 1) === 0;
        } else if (pattern === 'noise') {
          // Value noise: hash the *reference-resolution* pixel position.
          const hx = Math.floor(px / S), hy = Math.floor(py / S);
          shade = (hash2(hx, hy, seed) - 0.5) * 2;
          on = Math.abs(shade) < coverage * 0.5;
        } else if (pattern === 'grain') {
          const hx = Math.floor(px / S), hy = Math.floor(py / S);
          shade = (hash2(hx, hy, seed) - 0.5) * 2;
        }
        if (on) {
          if (background && pattern !== 'noise') {
            const t = thickness / spacing;
            const a = clamp(t * 3, 0, 1);
            this._blend(i, color, a);
          } else {
            this._blend(i, color, 1);
          }
        } else if (pattern === 'grain' || pattern === 'noise') {
          this._blend(i, [128, 128, 128], Math.abs(shade) * 0.55);
          if (pattern === 'grain') {
            this._blend(i, shade > 0 ? [255, 255, 255] : [0, 0, 0],
              Math.abs(shade) * amplitude / 255);
          }
        }
      }
    }
  }

  // Smooth, unique low-frequency field. Suitable for regions where no
  // repeated structure can be borrowed: the features are locally unique and
  // band-limited, so coarse matching has nothing exact to latch onto.
  uniqueField(x, y, w, h, opts = {}) {
    const S = this.ss;
    const { cell = 48, octaves = 3, seed = 1, from = [120, 130, 140],
      to = [205, 210, 216], alpha = 0.75 } = opts;
    const x0 = Math.max(0, Math.round(x * S));
    const y0 = Math.max(0, Math.round(y * S));
    const x1 = Math.min(this.rw, Math.round((x + w) * S));
    const y1 = Math.min(this.rh, Math.round((y + h) * S));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const u = (px / S - x) / cell;
        const v = (py / S - y) / cell;
        let n = 0, amp = 0.5, norm = 0;
        for (let o = 0; o < octaves; o++) {
          n += amp * valueNoise(u * (1 << o), v * (1 << o), seed + o * 131);
          norm += amp;
          amp *= 0.5;
        }
        n /= norm;
        const i = py * this.rw + px;
        this._blend(i, [
          from[0] + (to[0] - from[0]) * n,
          from[1] + (to[1] - from[1]) * n,
          from[2] + (to[2] - from[2]) * n,
        ], alpha);
      }
    }
  }

  // Per-reference-pixel i.i.d. grain. After blur+downsample this becomes
  // essentially flat, so no true detail can be recovered; any detail the SR
  // invents there is unsupported by observation.
  grain(x, y, w, h, opts = {}) {
    const S = this.ss;
    const { seed = 1, amplitude = 40, mono = true } = opts;
    const x0 = Math.max(0, Math.round(x * S));
    const y0 = Math.max(0, Math.round(y * S));
    const x1 = Math.min(this.rw, Math.round((x + w) * S));
    const y1 = Math.min(this.rh, Math.round((y + h) * S));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const rx = Math.floor(px / S), ry = Math.floor(py / S);
        const t = hash2(rx, ry, seed) - 0.5;
        const i = py * this.rw + px;
        const dr = t * 2 * amplitude;
        if (mono) {
          this.r[i] = Math.max(0, Math.min(255, this.r[i] + dr));
          this.g[i] = Math.max(0, Math.min(255, this.g[i] + dr));
          this.b[i] = Math.max(0, Math.min(255, this.b[i] + dr));
        } else {
          this.r[i] = Math.max(0, Math.min(255, this.r[i] + dr));
          this.b[i] = Math.max(0, Math.min(255, this.b[i] - dr));
        }
      }
    }
  }

  // Box-filter down to the reference grid and return an engine Image.
  finish() {
    const { width: W, height: H, ss: S, rw: RW } = this;
    const out = new Image(W, H, 3);
    const inv = 1 / (S * S);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sr = 0, sg = 0, sb = 0;
        for (let sy = 0; sy < S; sy++) {
          const row = (y * S + sy) * RW + x * S;
          for (let sx = 0; sx < S; sx++) {
            sr += this.r[row + sx];
            sg += this.g[row + sx];
            sb += this.b[row + sx];
          }
        }
        const i = y * W + x;
        out.planes[0][i] = clamp(sr * inv, 0, 255);
        out.planes[1][i] = clamp(sg * inv, 0, 255);
        out.planes[2][i] = clamp(sb * inv, 0, 255);
      }
    }
    return out;
  }
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
    + Math.imul(seed | 0, 69069)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

// Value noise in [0,1] from integer-lattice hashes with smooth interpolation.
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = hash2(xi, yi, seed);
  const v10 = hash2(xi + 1, yi, seed);
  const v01 = hash2(xi, yi + 1, seed);
  const v11 = hash2(xi + 1, yi + 1, seed);
  const sx = smooth(xf), sy = smooth(yf);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

function renderScene(scene) {
  const ss = scene.supersample || 3;
  const canvas = new Canvas(scene.width, scene.height, ss, scene.background);
  scene.draw(canvas);
  return canvas.finish();
}

module.exports = { Canvas, renderScene, clamp, mod };
