'use strict';
// Deterministic synthetic test scenes. Each scene is generated at a clear
// "reference" resolution; the SR pipeline only ever receives the degraded
// LR version. The HR reference is written alongside for evaluation ONLY and
// is never loaded by the engine or the GUI candidate search.

const path = require('path');
const fs = require('fs');
const { Image, degrade, writePNG } = require('../engine');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newImage(w, h) { return new Image(w, h, 3); }
function fill(img, v) { for (const p of img.planes) p.fill(v); }
function rect(img, x0, y0, x1, y1, rgb) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      for (let c = 0; c < 3; c++) img.planes[c][y * img.width + x] = rgb[c];
    }
  }
}
function hLine(img, y, x0, x1, rgb, t = 1) { rect(img, x0, y, x1, y + t, rgb); }
function vLine(img, x, y0, y1, rgb, t = 1) { rect(img, x, y0, x + t, y1, rgb); }

// 1. Repeated window panes: a grid of near-identical frames with slight
//    per-pane variation — strong cross-scale/self repetition.
function makePanes(size, rng) {
  const img = newImage(size, size);
  fill(img, 235);
  const cells = 4;
  const cell = size / cells;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const x0 = gx * cell, y0 = gy * cell;
      const shade = 150 + rng() * 40;
      rect(img, x0 + 6, y0 + 6, x0 + cell - 6, y0 + cell - 6, [shade * 0.7, shade * 0.85, shade]);
      // Inner mullions and a diagonal highlight — repeated sub-structure.
      vLine(img, x0 + cell / 2 | 0, y0 + 8, y0 + cell - 8, [60, 70, 80], 2);
      hLine(img, y0 + cell / 2 | 0, x0 + 8, x0 + cell - 8, [60, 70, 80], 2);
      for (let k = 0; k < 6; k++) {
        const lx = x0 + 10 + k * 4, ly = y0 + 10 + k * 4;
        rect(img, lx, ly, lx + 2, ly + 2, [220, 225, 230]);
      }
    }
  }
  // Outer frame.
  vLine(img, 2, 2, size - 2, [40, 45, 50], 4);
  vLine(img, size - 6, 2, size - 2, [40, 45, 50], 4);
  hLine(img, 2, 2, size - 2, [40, 45, 50], 4);
  hLine(img, size - 6, 2, size - 2, [40, 45, 50], 4);
  return img;
}

// 2. Thin lines / text-like strokes: 1-2 px structures that blur under
//    downsampling. Includes deterministic glyph-like shapes.
function makeThinLines(size, rng) {
  const img = newImage(size, size);
  fill(img, 250);
  for (let i = 0; i < 14; i++) {
    const y = 12 + i * 17;
    const rgb = [20 + rng() * 60, 20 + rng() * 60, 20 + rng() * 60];
    hLine(img, y, 14, size - 14 - (rng() * 80 | 0), rgb, 1 + (i % 2));
  }
  // Glyph-like rectangles (pseudo-letter strokes), no actual lettering.
  for (let g = 0; g < 6; g++) {
    const bx = 18 + g * 40, by = size - 48;
    vLine(img, bx, by, by + 34, [15, 15, 15], 2);
    hLine(img, by, bx, bx + 22, [15, 15, 15], 2);
    vLine(img, bx + 20, by, by + 16, [15, 15, 15], 2);
    hLine(img, by + 16, bx, bx + 20, [15, 15, 15], 2);
  }
  // A couple of diagonal 1px lines via explicit pixels.
  for (let k = 0; k < 60; k++) {
    const x = 20 + k, y = 60 + k;
    if (x < size && y < size) for (let c = 0; c < 3; c++) img.planes[c][y * size + x] = 30;
  }
  return img;
}

// 3. Random texture: dense high-frequency noise, locally self-similar in
//    statistics but with no repeated exact structure.
function makeRandomTexture(size, rng) {
  const img = newImage(size, size);
  // Neutral grey noise: identical across channels so the texture itself has
  // no chroma; any colour in the SR output would then be a true artifact.
  for (let i = 0; i < size * size; i++) {
    const v = 120 + (rng() - 0.5) * 160;
    img.planes[0][i] = v;
    img.planes[1][i] = v;
    img.planes[2][i] = v;
  }
  // Add a few larger blobs so the scene has some structure too.
  for (let b = 0; b < 12; b++) {
    const cx = rng() * size, cy = rng() * size, r = 12 + rng() * 20;
    const shade = 90 + rng() * 120;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        const a = 1 - d / r;
        for (let c = 0; c < 3; c++) {
          const idx = y * size + x;
          img.planes[c][idx] = img.planes[c][idx] * (1 - a * 0.6) + shade * a * 0.6;
        }
      }
    }
  }
  return img;
}

// 4. Low self-similarity: a smooth gradient scene with one unique curved
//    object and isolated distinct marks — very few reusable patches.
function makeUniqueScene(size, rng) {
  const img = newImage(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      img.planes[0][i] = 40 + 180 * (x / size);
      img.planes[1][i] = 50 + 120 * (y / size);
      img.planes[2][i] = 120 + 100 * ((x + y) / (2 * size));
    }
  }
  // One unique circle.
  const cx = size * 0.35, cy = size * 0.4, r = size * 0.18;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < r) {
      const a = 1 - d / r;
      const idx = y * size + x;
      img.planes[0][idx] = img.planes[0][idx] * (1 - a) + 200 * a;
      img.planes[1][idx] = img.planes[1][idx] * (1 - a) + 60 * a;
      img.planes[2][idx] = img.planes[2][idx] * (1 - a) + 70 * a;
    }
  }
  // A handful of unique, non-repeating specks at distinct grey levels.
  for (let k = 0; k < 8; k++) {
    const x = (rng() * size) | 0, y = (rng() * size) | 0;
    rect(img, x, y, x + 3, y + 3, [rng() * 255, rng() * 255, rng() * 255]);
  }
  return img;
}

function main() {
  const outDir = path.join(__dirname, 'inputs');
  fs.mkdirSync(outDir, { recursive: true });
  const HR = 256, LR = 128;
  const scenes = {
    panes: makePanes,
    thinlines: makeThinLines,
    texture: makeRandomTexture,
    unique: makeUniqueScene,
  };
  const manifest = [];
  for (const [name, fn] of Object.entries(scenes)) {
    const rng = mulberry32(name.length * 7919 + 17);
    const hr = fn(HR, rng);
    const lr = degrade(hr, HR / LR, 1.0);
    const hrPath = path.join(outDir, `${name}_HR.png`);
    const lrPath = path.join(outDir, `${name}_LR.png`);
    fs.writeFileSync(hrPath, writePNG(hr));
    fs.writeFileSync(lrPath, writePNG(lr));
    manifest.push({ scene: name, hr: hrPath, lr: lrPath, hrSize: [HR, HR], lrSize: [LR, LR] });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${manifest.length * 2} images to ${outDir}`);
}

if (require.main === module) main();
module.exports = { mulberry32, makePanes, makeThinLines, makeRandomTexture, makeUniqueScene };
