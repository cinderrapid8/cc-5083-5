'use strict';
// Parameter sweep: runs the same input through a grid of parameter values and
// records one summary row per combination, so the effect of each knob is
// inspectable rather than asserted. Does not use any reference image.

const fs = require('fs');
const path = require('path');
const { readPNG, runSuperResolution } = require('../engine');

function mean(arr) { let s = 0; for (const v of arr) s += v; return s / arr.length; }
function fraction(arr, thr) { let k = 0; for (const v of arr) if (v > thr) k++; return k / arr.length; }

const SWEEPS = {
  confidenceThreshold: [0.2, 0.35, 0.45, 0.6, 0.75],
  patchSize: [3, 5, 7],
  pyramidLevels: [1, 2, 3],
  rotationPenalty_90: [0, 3, 6, 12],
  brightnessWeight: [0, 0.2, 0.35, 0.8],
  scalePenalty: [0, 1.5, 3, 6],
};

function main() {
  const [inputPath, outDir, scaleArg] = process.argv.slice(2);
  if (!inputPath || !outDir) {
    console.error('usage: node cli/sweep.js <input.png> <outDir> [scale]');
    process.exit(2);
  }
  const scale = Number(scaleArg || 2);
  const input = readPNG(fs.readFileSync(inputPath));
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const [key, values] of Object.entries(SWEEPS)) {
    for (const value of values) {
      const overrides = {};
      if (key.startsWith('rotationPenalty_')) {
        overrides.rotationPenalty = { [key.split('_')[1]]: value };
      } else {
        overrides[key] = value;
      }
      const t0 = Date.now();
      const res = runSuperResolution(input, scale, overrides);
      rows.push({
        param: key,
        value,
        elapsedMs: Date.now() - t0,
        residualRMS: res.residualRMS,
        meanConfidence: Number(mean(res.confidenceMap).toFixed(4)),
        transferFraction: Number(fraction(res.transferMap, 0.5).toFixed(4)),
      });
    }
  }
  const outFile = path.join(outDir, 'sweep.json');
  fs.writeFileSync(outFile, JSON.stringify({ input: path.resolve(inputPath), scale, rows }, null, 2));
  for (const r of rows) {
    console.log(`${r.param}=${String(r.value).padEnd(5)} transfer=${r.transferFraction} conf=${r.meanConfidence} residRMS=${r.residualRMS} ms=${r.elapsedMs}`);
  }
  console.log('wrote', outFile);
}

if (require.main === module) main();
