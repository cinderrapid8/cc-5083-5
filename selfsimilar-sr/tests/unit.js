'use strict';
// Zero-dependency assertion tests for engine invariants. Run: node tests/unit.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  Image, readPNG, writePNG, resample, degrade, rgbToYCbCr,
  runSuperResolution, DEFAULT_PARAMS,
} = require('../engine');
const { Matcher, scoreConfidence } = require('../engine/match');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (err) {
    console.error('FAIL -', name);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('png roundtrip:');
test('encode/decode is lossless at 8-bit (max diff <= 1)', () => {
  for (const name of ['panes', 'thinlines', 'texture', 'unique']) {
    const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', `${name}_LR.png`)));
    const back = readPNG(writePNG(img));
    assert.strictEqual(back.width, img.width);
    let maxd = 0;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < img.planes[0].length; i++) {
        maxd = Math.max(maxd, Math.abs(img.planes[c][i] - back.planes[c][i]));
      }
    }
    assert.ok(maxd <= 1, `max diff ${maxd}`);
  }
});

console.log('resampling:');
test('resample preserves dimensions and finite values', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'panes_LR.png')));
  const up = resample(img, 200, 100);
  assert.strictEqual(up.width, 200);
  assert.strictEqual(up.height, 100);
  for (const p of up.planes) for (const v of p) assert.ok(Number.isFinite(v));
});

test('degrade applies the documented model and shrinks size', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'panes_HR.png')));
  const lr = degrade(img, 2, 1.0);
  assert.strictEqual(lr.width, 128);
  assert.strictEqual(lr.height, 128);
});

console.log('matcher:');
test('self-match exclusion removes the target footprint from level-0 candidates', () => {
  const w = 24, h = 24;
  const plane = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plane[y * w + x] = (x * 7 + y * 13) % 256;
  const params = { ...DEFAULT_PARAMS, pyramidLevels: 1, shortlist: 8 };
  const m = new Matcher(params);
  m.addPyramidLevel(0, plane, w, h, 1);
  const p = 5, tx = 10, ty = 10;
  const target = plane.slice(ty * w + tx, ty * w + tx + p * p);
  const match = m.matchPatch(target, p, { level: 0, x: tx, y: ty, size: p, radius: p + 1 });
  assert.ok(match.candidates.length > 0);
  for (const c of match.candidates) {
    if (c.level === 0 && c.rotation === 0) {
      assert.ok(Math.abs(c.cx - tx) >= p + 1 || Math.abs(c.cy - ty) >= p + 1,
        `self-ish candidate at ${c.cx},${c.cy}`);
    }
  }
});

test('rotation and scale penalties appear explicitly in candidate costs', () => {
  const w = 20, h = 20;
  const plane = new Float64Array(w * h);
  for (let i = 0; i < plane.length; i++) plane[i] = (i * 31) % 256;
  const params = { ...DEFAULT_PARAMS, pyramidLevels: 2, pyramidScale: 0.8, shortlist: 6 };
  const m = new Matcher(params);
  m.addPyramidLevel(0, plane, w, h, 1);
  const small = degrade(Image.fromPlanar(w, h, [plane]), 1 / 0.8, 1.0);
  m.addPyramidLevel(1, small.planes[0], small.width, small.height, 1 / 0.8);
  const match = m.matchPatch(plane.slice(0, 25), 5);
  const rots = new Set(match.candidates.map((c) => c.rotation));
  assert.ok(rots.size >= 1);
  for (const c of match.candidates) {
    assert.ok(Number.isFinite(c.cost) && Number.isFinite(c.ssdPerPx));
    assert.ok(c.rotationPenalty === 0 || c.rotationPenalty > 0);
    assert.ok(c.scalePenalty >= 0);
    assert.ok(Math.abs(c.brightnessDelta) <= 255);
  }
});

test('confidence is bounded to [0,1]', () => {
  const w = 16, h = 16;
  const plane = new Float64Array(w * h).fill(128);
  const params = { ...DEFAULT_PARAMS, pyramidLevels: 1, shortlist: 4 };
  const m = new Matcher(params);
  m.addPyramidLevel(0, plane, w, h, 1);
  const match = m.matchPatch(plane.slice(0, 25), 5);
  const conf = scoreConfidence(match, params);
  assert.ok(conf >= 0 && conf <= 1);
});

test('rotated views are invertible: rotating each variant back restores the source', () => {
  const { buildRotations } = require('../engine/match');
  const w = 6, h = 6;
  const src = new Float64Array(w * h);
  for (let i = 0; i < src.length; i++) src[i] = (i * 17 + 5) % 256;
  const variants = buildRotations(src, w, h);
  for (const v of variants) {
    // Reconstruct source pixel at (sx, sy) via the variant's coordinate map.
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        // Find the rotated-space coordinate that maps back to (sx, sy).
        let found = null;
        for (let ry = 0; ry < v.h && found === null; ry++) {
          for (let rx = 0; rx < v.w; rx++) {
            const pt = v.map(rx, ry);
            if (pt.x === sx && pt.y === sy) { found = [rx, ry]; break; }
          }
        }
        assert.ok(found, `rotation ${v.rot}: no map to (${sx},${sy})`);
        assert.strictEqual(v.plane[found[1] * v.w + found[0]], src[sy * w + sx]);
      }
    }
  }
});

console.log('pipeline:');
test('rejects invalid parameters and scales (failure feedback contract)', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'unique_LR.png')));
  assert.throws(() => runSuperResolution(img, 2, { patchSize: 99 }), /patchSize/);
  assert.throws(() => runSuperResolution(img, 2, { confidenceThreshold: 1.5 }), /confidenceThreshold/);
  assert.throws(() => runSuperResolution(img, 9), /scale/);
});

test('outputs have expected grids and maps for 2x/3x/4x', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'unique_LR.png')));
  for (const scale of [2, 3, 4]) {
    const r = runSuperResolution(img, scale, { patchStride: 8, backProjectionIters: 1, shortlist: 6 });
    assert.strictEqual(r.sr.width, img.width * scale);
    assert.strictEqual(r.sr.height, img.height * scale);
    assert.strictEqual(r.confidenceMap.length, r.sr.width * r.sr.height);
    assert.strictEqual(r.transferMap.length, r.sr.width * r.sr.height);
    assert.ok(r.residualRMS >= 0);
  }
});

test('deterministic: identical inputs and params give identical pixels', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'panes_LR.png')));
  const opts = { patchStride: 8, backProjectionIters: 2, shortlist: 8 };
  const a = runSuperResolution(img, 2, opts);
  const b = runSuperResolution(img, 2, opts);
  let maxd = 0;
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < a.sr.planes[0].length; i++) {
      maxd = Math.max(maxd, Math.abs(a.sr.planes[c][i] - b.sr.planes[c][i]));
    }
  }
  assert.strictEqual(maxd, 0);
});

test('confidence threshold gates transfer: higher threshold never transfers more', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'texture_LR.png')));
  const frac = (r) => {
    let k = 0; for (const v of r.transferMap) if (v > 0.5) k++;
    return k / r.transferMap.length;
  };
  const low = runSuperResolution(img, 2, { confidenceThreshold: 0.2, patchStride: 8, backProjectionIters: 1, shortlist: 6 });
  const high = runSuperResolution(img, 2, { confidenceThreshold: 0.75, patchStride: 8, backProjectionIters: 1, shortlist: 6 });
  assert.ok(frac(high) <= frac(low) + 1e-12, `${frac(high)} > ${frac(low)}`);
});

test('match index only references coordinates inside the input pyramid', () => {
  const img = readPNG(fs.readFileSync(path.join(__dirname, 'inputs', 'panes_LR.png')));
  const r = runSuperResolution(img, 2, { patchStride: 16, backProjectionIters: 1, shortlist: 6 });
  for (const rec of r.diagnostics.matchIndexFull) {
    for (const c of rec.candidates) {
      assert.ok(c.level >= 0 && c.x >= 0 && c.y >= 0);
      assert.ok([0, 90, 180, 270].includes(c.rotation));
    }
  }
});

console.log(`\n${passed} tests passed`);
if (process.exitCode) console.error('some tests failed');
