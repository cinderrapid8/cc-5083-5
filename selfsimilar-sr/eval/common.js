'use strict';
// Shared helpers for the asset-suite evaluation.
//
// Isolation contract:
//   * this module only ever opens the LR input and the sealed ledger;
//   * the reference HR image is opened exclusively by eval/reference.js, which
//     is called after the reconstruction result is already in memory.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'assets', 'ledger.json');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Stable digest of decoded pixel content. Values are rounded to the 8-bit
// levels a PNG can actually store, so the digest computed from an in-memory
// render and the digest computed after decoding the written PNG agree.
function imageDigest(img) {
  const h = crypto.createHash('sha256');
  const head = Buffer.alloc(9);
  head.writeUInt32BE(img.width, 0);
  head.writeUInt32BE(img.height, 4);
  head[8] = img.channels;
  h.update(head);
  const row = Buffer.alloc(img.width * img.channels);
  for (let y = 0; y < img.height; y++) {
    let k = 0;
    for (let x = 0; x < img.width; x++) {
      const i = y * img.width + x;
      for (let c = 0; c < img.channels; c++) {
        row[k++] = Math.round(Math.max(0, Math.min(255, img.planes[c][i])));
      }
    }
    h.update(row);
  }
  return h.digest('hex');
}

// Digest of the decoded image read from a PNG file, applying the same
// normalisation: RGB channels only, matching how the engine loads inputs.
function digestOfPNGBuffer(buf) {
  const { readPNG } = require('../engine/png');
  return imageDigest(readPNG(buf));
}

function loadLedger() {
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

// Set of reference-image digests. The runner refuses anything that hashes to
// one of these, which blocks the trivial "point the input at HR.png" cheat.
function sealedReferenceDigests(ledger) {
  const out = new Set();
  for (const s of ledger.scenes) {
    for (const v of Object.values(s.scales)) out.add(v.referencePixelDigest);
  }
  return out;
}

// Look up a recipe by scene name and scale. The returned object includes the
// reference path; only the evaluator (run_suite / reference.js) may use it.
// The isolated runner process never calls this with a user-supplied path.
function recipeFor(ledger, scene, scale) {
  const entry = ledger.scenes.find((s) => s.scene === scene);
  if (!entry) throw new Error(`unknown scene ${scene}`);
  const scaleKey = `${scale}x`;
  if (!entry.scales[scaleKey]) throw new Error(`scene ${scene} has no ${scaleKey} build`);
  const recipePath = path.join(ROOT, 'assets', 'recipes', `${scene}_${scaleKey}.json`);
  return JSON.parse(fs.readFileSync(recipePath, 'utf8'));
}

// Union of two rectangles; used to merge local blocks into region windows.
function rectUnion(a, b) {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
}

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return arr.length ? s / arr.length : 0;
}

module.exports = {
  ROOT, LEDGER_PATH, sha256, imageDigest, loadLedger, sealedReferenceDigests,
  recipeFor, rectUnion, mean,
};
