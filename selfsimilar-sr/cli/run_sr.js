'use strict';
// Command-line entry point for self-similarity super-resolution.
//
// Usage:
//   node cli/run_sr.js <input.png> <outDir> [--scale 2] [--json params.json]
//                      [--set key=value ...]
//
// Writes the SR image, bicubic baseline, reprojected image, residual,
// confidence heatmap, transfer overlay, the full match index and a run
// manifest containing every parameter, so the run can be reproduced exactly.

const fs = require('fs');
const path = require('path');
const { readPNG, writePNG, runSuperResolution, DEFAULT_PARAMS, heatmap, transferOverlay } = require('../engine');

function parseArgs(argv) {
  const args = { positional: [], set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'set') {
        const kv = argv[++i];
        const eq = kv.indexOf('=');
        args.set[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else {
        args[key] = argv[++i];
      }
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  try { return JSON.parse(v); } catch { return v; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [inputPath, outDir] = args.positional;
  if (!inputPath || !outDir) {
    console.error('usage: node cli/run_sr.js <input.png> <outDir> [--scale 2] [--json params.json] [--set k=v ...]');
    process.exit(2);
  }
  const overrides = {};
  if (args.json) Object.assign(overrides, JSON.parse(fs.readFileSync(args.json, 'utf8')));
  for (const [k, v] of Object.entries(args.set)) overrides[k] = coerce(v);
  const scale = Number(args.scale || overrides.scale || 2);

  const input = readPNG(fs.readFileSync(inputPath));
  const result = runSuperResolution(input, scale, overrides);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(inputPath, path.extname(inputPath));

  const files = {
    sr: `${base}_SR.png`,
    bicubic: `${base}_bicubic.png`,
    reprojected: `${base}_reprojected.png`,
    residual: `${base}_residual.png`,
    confidence: `${base}_confidence.png`,
    transfer: `${base}_transfer.png`,
    matchIndex: `${base}_matches.json`,
    manifest: `${base}_run.json`,
  };
  fs.writeFileSync(path.join(outDir, files.sr), writePNG(result.sr));
  fs.writeFileSync(path.join(outDir, files.bicubic), writePNG(result.bicubic));
  fs.writeFileSync(path.join(outDir, files.reprojected), writePNG(result.reprojected));
  fs.writeFileSync(path.join(outDir, files.residual), writePNG(result.residual));
  fs.writeFileSync(path.join(outDir, files.confidence),
    writePNG(heatmap(result.confidenceMap, result.sr.width, result.sr.height)));
  fs.writeFileSync(path.join(outDir, files.transfer),
    writePNG(transferOverlay(result.transferMap, result.sr.width, result.sr.height, result.sr)));
  fs.writeFileSync(path.join(outDir, files.matchIndex),
    JSON.stringify({ scale, params: result.params, matches: result.diagnostics.matchIndexFull }));

  const manifest = {
    input: path.resolve(inputPath),
    inputSize: [input.width, input.height],
    outputSize: [result.sr.width, result.sr.height],
    scale,
    params: result.params,
    defaults: DEFAULT_PARAMS,
    files,
    diagnostics: {
      elapsedMs: result.diagnostics.elapsedMs,
      residualRMS: result.residualRMS,
      residualMax: result.residualMax,
      steps: result.diagnostics.steps,
      rgbBackProjectionRMS: result.diagnostics.rgbBackProjectionRMS,
    },
    engine: 'selfsimilar-sr (zero-dependency Node.js, deterministic, no RNG in pipeline)',
    node: process.version,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, files.manifest), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, files, residualRMS: result.residualRMS,
    elapsedMs: result.diagnostics.elapsedMs }, null, 2));
}

if (require.main === module) main();
