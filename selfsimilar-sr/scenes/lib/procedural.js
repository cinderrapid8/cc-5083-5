'use strict';
// Procedural vector primitives shared by the rasterizer and the SVG export.
//
// Each generator returns a flat list of concrete shapes:
//   { type: 'rect', x, y, w, h, color, alpha }
//   { type: 'segment', x1, y1, x2, y2, width, color, alpha, round }
//   { type: 'circle', cx, cy, r, color, alpha }
//   { type: 'polygon', points, color, alpha }
// The same shape list is drawn by scenes/lib/canvas.js and serialised by
// scenes/lib/svg.js, so the editable spec is the single source of truth.

const { hash2 } = require('./rng');

function shade(base, jitter, seed, a, b) {
  const t = hash2(a, b, seed) - 0.5;
  return [
    Math.max(0, Math.min(255, base[0] + jitter * t)),
    Math.max(0, Math.min(255, base[1] + jitter * t)),
    Math.max(0, Math.min(255, base[2] + jitter * t)),
  ];
}

function isDecoy(cell, decoyCells) {
  if (!decoyCells) return false;
  return decoyCells.some(([r, c]) => r === cell[0] && c === cell[1]);
}

// Repeated architectural panels. At reference resolution each panel carries
// mullions, a sill and a diagonal glazing highlight. `decoyCells` marks cells
// whose fine detail differs by a sub-pixel-at-LR amount: the coarse panel still
// matches nearby panels almost perfectly, which is exactly the misleading
// case the evaluation wants to expose.
function panelGrid(p) {
  const shapes = [];
  const cols = p.cols, rows = p.rows;
  const gapX = p.gapX != null ? p.gapX : 10;
  const gapY = p.gapY != null ? p.gapY : 12;
  const cellW = (p.w - (cols - 1) * gapX) / cols;
  const cellH = (p.h - (rows - 1) * gapY) / rows;
  const frameT = p.frameThickness != null ? p.frameThickness : 5;
  const seed = p.seed | 0;
  const frameColor = p.frameColor || [72, 80, 88];
  const glassBase = p.glassColor || [176, 190, 204];
  const decoyCells = p.decoyCells || [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = p.x + c * (cellW + gapX);
      const y0 = p.y + r * (cellH + gapY);
      const decoy = isDecoy([r, c], decoyCells);
      const glass = shade(glassBase, 16, seed + 11, r * 17 + 3, c * 29 + 5);

      // Outer frame + inner glazing.
      shapes.push({ type: 'rect', x: x0, y: y0, w: cellW, h: cellH, color: frameColor, alpha: 1 });
      const gx = x0 + frameT, gy = y0 + frameT;
      const gw = cellW - frameT * 2, gh = cellH - frameT * 2;
      shapes.push({ type: 'rect', x: gx, y: gy, w: gw, h: gh, color: glass, alpha: 1 });

      // Glazing highlight: a fixed diagonal so repeated panels are alike.
      if (!decoy) {
        shapes.push({
          type: 'segment', x1: gx + 2, y1: gy + gh - 3, x2: gx + gw * 0.42, y2: gy + 3,
          width: Math.max(1.5, cellH * 0.05), color: [240, 247, 252], alpha: 0.5, round: false,
        });
        shapes.push({
          type: 'segment', x1: gx + gw * 0.55, y1: gy + gh - 3, x2: gx + gw - 3, y2: gy + gh * 0.35,
          width: Math.max(1.2, cellH * 0.035), color: [245, 250, 254], alpha: 0.32, round: false,
        });
      } else {
        // Decoy variant: highlight reflected the other way, plus a thin extra
        // bar that is a fraction of an LR pixel wide.
        shapes.push({
          type: 'segment', x1: gx + gw - 3, y1: gy + gh - 3, x2: gx + gw * 0.5, y2: gy + 3,
          width: Math.max(1.5, cellH * 0.05), color: [240, 247, 252], alpha: 0.5, round: false,
        });
        shapes.push({
          type: 'segment', x1: gx + 1.5, y1: gy + gh * 0.72, x2: gx + gw * 0.62, y2: gy + gh * 0.72,
          width: 1.1, color: [88, 104, 118], alpha: 0.9, round: false,
        });
      }

      // Cross mullion. The decoy shifts it by 1.5 px, invisible after blur+downsample.
      const midX = gx + gw / 2 + (decoy ? 1.5 : 0);
      const midY = gy + gh / 2;
      const mull = p.mullionColor || [96, 106, 116];
      shapes.push({ type: 'rect', x: midX - 1.25, y: gy, w: 2.5, h: gh, color: mull, alpha: 1 });
      shapes.push({ type: 'rect', x: gx, y: midY - 1.25, w: gw, h: 2.5, color: mull, alpha: 1 });

      // Sill / ledge under each window.
      shapes.push({
        type: 'rect', x: x0 - 1, y: y0 + cellH - 2.5, w: cellW + 2, h: 4,
        color: p.sillColor || [158, 148, 132], alpha: 1,
      });
    }
  }
  return shapes;
}

// Pseudo-text glyph row. Strokes are abstract (no real alphabet), repeated
// with a seeded template choice so the same forms recur many times. A decoy
// glyph keeps the coarse strokes of a common form but adds a thin terminal
// that only exists at reference resolution.
const GLYPH_TEMPLATES = [
  [[0.20, 0.12, 0.80, 0.12], [0.20, 0.12, 0.20, 0.88], [0.20, 0.50, 0.74, 0.50]],
  [[0.20, 0.12, 0.20, 0.88], [0.52, 0.12, 0.52, 0.62], [0.20, 0.12, 0.52, 0.12], [0.52, 0.62, 0.78, 0.62]],
  [[0.20, 0.12, 0.62, 0.50], [0.62, 0.50, 0.20, 0.88], [0.20, 0.12, 0.20, 0.88]],
  [[0.18, 0.16, 0.70, 0.16], [0.70, 0.16, 0.70, 0.84], [0.18, 0.50, 0.44, 0.50], [0.18, 0.84, 0.70, 0.84]],
  [[0.22, 0.14, 0.22, 0.60], [0.22, 0.60, 0.52, 0.60], [0.52, 0.60, 0.52, 0.86], [0.66, 0.14, 0.72, 0.30]],
];

function glyphBand(p) {
  const shapes = [];
  const cols = p.cols, rows = p.rows;
  const gapX = p.gapX != null ? p.gapX : 8;
  const gapY = p.gapY != null ? p.gapY : 14;
  const cellW = (p.w - (cols - 1) * gapX) / cols;
  const cellH = (p.h - (rows - 1) * gapY) / rows;
  const stroke = p.stroke != null ? p.stroke : Math.max(1.4, cellW * 0.075);
  const ink = p.color || [28, 30, 36];
  const seed = p.seed | 0;
  const decoyCells = p.decoyCells || [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = p.x + c * (cellW + gapX);
      const y0 = p.y + r * (cellH + gapY);
      const tmpl = GLYPH_TEMPLATES[Math.floor(hash2(c, r, seed) * GLYPH_TEMPLATES.length) % GLYPH_TEMPLATES.length];
      for (const [ax, ay, bx, by] of tmpl) {
        shapes.push({
          type: 'segment',
          x1: x0 + ax * cellW, y1: y0 + ay * cellH,
          x2: x0 + bx * cellW, y2: y0 + by * cellH,
          width: stroke, color: ink, alpha: 1, round: false,
        });
      }
      if (isDecoy([r, c], decoyCells)) {
        // Thin terminal that vanishes under the LR blur but changes the HR
        // answer locally: a copied common glyph is now wrong here.
        shapes.push({
          type: 'segment',
          x1: x0 + cellW * 0.52, y1: y0 + cellH * 0.12,
          x2: x0 + cellW * 0.52, y2: y0 + cellH * 0.30,
          width: Math.max(0.9, stroke * 0.42), color: ink, alpha: 1, round: false,
        });
      }
    }
  }
  return shapes;
}

// Bands of isolated thin lines with irregular spacing, optional gaps and
// alternating thickness. Used for the "thin lines" family and as balcony
// railings in the facade scenes.
function stripeField(p) {
  const shapes = [];
  const seed = p.seed | 0;
  const color = p.color || [52, 56, 62];
  const dir = p.direction || 'h';
  const minGap = p.minGap != null ? p.minGap : 4;
  const maxGap = p.maxGap != null ? p.maxGap : 9;
  const breakChance = p.breakChance != null ? p.breakChance : 0.4;
  const thickEvery = p.thickEvery != null ? p.thickEvery : 5;
  const thick = p.thickness != null ? p.thickness : 1;
  const span = dir === 'h' ? p.h : p.w;
  let cursor = 0, index = 0;
  while (cursor < span) {
    const gap = minGap + (maxGap - minGap) * hash2(index, seed, 7);
    const at = cursor + gap * 0.5;
    const t = (index % thickEvery === 0) ? thick + 1 : thick;
    const alpha = 0.72 + 0.24 * hash2(index, seed, 3);
    if (dir === 'h') {
      const y = p.y + at;
      const jitterA = hash2(index, seed, 11), jitterB = hash2(index, seed, 13);
      const x0 = p.x + p.w * 0.02 + p.w * 0.10 * jitterA;
      const x1 = p.x + p.w * 0.98 - p.w * 0.10 * jitterB;
      if (hash2(index, seed, 17) < breakChance) {
        const bx = x0 + (x1 - x0) * (0.35 + 0.3 * hash2(index, seed, 19));
        const bw = Math.max(2, (x1 - x0) * 0.05);
        shapes.push({ type: 'segment', x1: x0, y1: y, x2: bx, y2: y, width: t, color, alpha, round: false });
        shapes.push({ type: 'segment', x1: bx + bw, y1: y, x2: x1, y2: y, width: t, color, alpha, round: false });
      } else {
        shapes.push({ type: 'segment', x1: x0, y1: y, x2: x1, y2: y, width: t, color, alpha, round: false });
      }
    } else {
      const x = p.x + at;
      const jitterA = hash2(index, seed, 21), jitterB = hash2(index, seed, 23);
      const y0 = p.y + p.h * 0.02 + p.h * 0.10 * jitterA;
      const y1 = p.y + p.h * 0.98 - p.h * 0.10 * jitterB;
      if (hash2(index, seed, 27) < breakChance) {
        const by = y0 + (y1 - y0) * (0.35 + 0.3 * hash2(index, seed, 29));
        const bh = Math.max(2, (y1 - y0) * 0.05);
        shapes.push({ type: 'segment', x1: x, y1: y0, x2: x, y2: by, width: t, color, alpha, round: false });
        shapes.push({ type: 'segment', x1: x, y1: by + bh, x2: x, y2: y1, width: t, color, alpha, round: false });
      } else {
        shapes.push({ type: 'segment', x1: x, y1: y0, x2: x, y2: y1, width: t, color, alpha, round: false });
      }
    }
    cursor += gap + t;
    index++;
  }
  return shapes;
}

// Soft radial marker; unique objects in the low-similarity scene.
function blob(p) {
  return [{ type: 'circle', cx: p.cx, cy: p.cy, r: p.r, color: p.color, alpha: p.alpha != null ? p.alpha : 1 }];
}

function expandProcedural(op) {
  switch (op.op) {
    case 'panelGrid': return panelGrid(op);
    case 'glyphBand': return glyphBand(op);
    case 'stripeField': return stripeField(op);
    case 'blob': return blob(op);
    default: return null;
  }
}

module.exports = { panelGrid, glyphBand, stripeField, blob, expandProcedural, GLYPH_TEMPLATES };
