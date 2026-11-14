'use strict';
// Standalone difference-image entry.
//
// Given an already-finished run directory (containing SR.png and bicubic.png),
// regenerate the per-region reference crops and difference maps without
// re-running the reconstruction. This is the "diff image" deliverable: it
// shows local residuals rather than a single cherry-picked average.
//
// The clear reference is opened here, on the evaluator side only, after the
// run already exists. Use with scene + scale so the sealed recipe supplies the
// reference path.
//
// Usage:
//   node eval/make_diff.js --scene facade --scale 2 [--run runs/eval/facade_2x]
//   node eval/make_diff.js <runDir> --scene facade --scale 2

const fs = require('fs');
const path = require('path');

const { ROOT, loadLedger, recipeFor } = require('./common');
const { regionDiffMaps, regionStats } = require('./reference');
const { readPNG, writePNG } = require('../engine');

function parseArgs(argv) {
  const a = { positional: [], scene: null, scale: null, run: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--scene') a.scene = argv[++i];
    else if (v === '--scale') a.scale = Number(argv[++i]);
    else if (v === '--run') a.run = argv[++i];
    else if (v.startsWith('--')) throw new Error(`unknown flag ${v}`);
    else a.positional.push(v);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scene || !args.scale) {
    throw new Error('usage: node eval/make_diff.js --scene <name> --scale <2|3|4> [--run <dir>]');
  }
  const ledger = loadLedger();
  const entry = ledger.scenes.find((s) => s.scene === args.scene);
  if (!entry) throw new Error(`unknown scene ${args.scene}`);
  const runDir = args.run || args.positional[0]
    || path.join(ROOT, 'runs', 'eval', `${args.scene}_${args.scale}x`);
  const srPath = path.join(runDir, 'SR.png');
  const biPath = path.join(runDir, 'bicubic.png');
  if (!fs.existsSync(srPath) || !fs.existsSync(biPath)) {
    throw new Error(`${runDir} has no SR.png/bicubic.png; run eval/run_eval.js first`);
  }

  const sr = readPNG(fs.readFileSync(srPath));
  const bicubic = readPNG(fs.readFileSync(biPath));
  const recipe = recipeFor(ledger, args.scene, args.scale);
  const ref = readPNG(fs.readFileSync(path.join(ROOT, recipe.reference)));
  if (ref.width !== sr.width || ref.height !== sr.height) {
    throw new Error(`grid mismatch: reference ${ref.width}x${ref.height} vs SR `
      + `${sr.width}x${sr.height}; refusing to diff misaligned grids`);
  }

  const diffDir = path.join(runDir, 'diff');
  fs.mkdirSync(diffDir, { recursive: true });
  const summary = [];
  for (const region of entry.regions) {
    const rect = region.rect.map(Number);
    const st = regionStats(sr, bicubic, ref, rect);
    const maps = regionDiffMaps(sr, bicubic, ref, rect);
    const safe = region.name.replace(/[^a-z0-9_-]+/gi, '_');
    fs.writeFileSync(path.join(diffDir, `${safe}_sr.png`), writePNG(maps.srCrop));
    fs.writeFileSync(path.join(diffDir, `${safe}_bicubic.png`), writePNG(maps.bicubicCrop));
    fs.writeFileSync(path.join(diffDir, `${safe}_ref.png`), writePNG(maps.refCrop));
    fs.writeFileSync(path.join(diffDir, `${safe}_diff_sr.png`), writePNG(maps.srDiffMap));
    fs.writeFileSync(path.join(diffDir, `${safe}_diff_bicubic.png`), writePNG(maps.bicubicDiffMap));
    summary.push({ region: region.name, kind: region.kind, rect, psnrGain: st.psnrGain });
  }
  console.log(JSON.stringify({ ok: true, runDir, diffDir, regions: summary }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}
module.exports = { main, parseArgs };
