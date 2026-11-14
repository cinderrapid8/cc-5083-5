'use strict';
// Isolated run executor for the self-similarity evaluation.
//
// CONTRACT
//   * The runner is given ONE path: a PNG input file.
//   * It resolves the reference path from the sealed ledger ONLY through
//     the scene/scale recipe, and only exports it to a separate evaluator
//     process; the matching engine receives the decoded LR image and nothing
//     else.
//   * If the supplied file's decoded digest equals any sealed reference
//     digest, the run is refused (exit 3). Renaming HR.png to LR.png does not
//     help: the check is on content, not on the file name.
//   * The runner writes only images derived from the input — never the
//     reference — into the output directory.
//
// Usage:
//   node eval/run_eval.js <input.png> <outDir> --scale 2
//   node eval/run_eval.js --scene facade --scale 2      (uses ledger input path)
//   node eval/run_suite.js                               (runs all and scores)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  readPNG, writePNG, runSuperResolution, DEFAULT_PARAMS,
} = require('../engine');
const {
  heatmap, transferOverlay,
} = require('../engine/viz');
const { loadLedger, sealedReferenceDigests, imageDigest, recipeFor, sha256 } = require('./common');

function parseArgs(argv) {
  const a = { positional: [], overrides: {}, scale: null, scene: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--scale') a.scale = Number(argv[++i]);
    else if (v === '--scene') a.scene = argv[++i];
    else if (v === '--set') {
      const kv = argv[++i];
      const eq = kv.indexOf('=');
      a.overrides[kv.slice(0, eq)] = coerce(kv.slice(eq + 1));
    } else if (v.startsWith('--')) {
      throw new Error(`unknown flag ${v}`);
    } else a.positional.push(v);
  }
  return a;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  try { return JSON.parse(v); } catch { return v; }
}

function resolveTarget(args, ledger) {
  const { ROOT } = require('./common');
  if (args.scene) {
    const scale = args.scale || 2;
    const entry = ledger.scenes.find((s) => s.scene === args.scene);
    if (!entry) throw new Error(`unknown scene ${args.scene}`);
    const r = recipeFor(ledger, args.scene, scale);
    const outDir = args.positional[1]
      || path.join(ROOT, 'runs', 'eval', `${args.scene}_${scale}x`);
    return { scene: args.scene, scale, inputPath: path.join(ROOT, r.input), outDir };
  }
  const [inputPath, outDir] = args.positional;
  if (!inputPath) throw new Error('usage: node eval/run_eval.js <input.png> <outDir> --scale N');
  if (!outDir) throw new Error('missing output directory');
  return { scene: null, scale: args.scale, inputPath, outDir };
}

// The isolation check: refuse inputs that ARE a sealed reference.
function refuseReference(img, ledger) {
  const sealed = sealedReferenceDigests(ledger);
  const digest = imageDigest(img);
  if (sealed.has(digest)) {
    const who = [];
    for (const s of ledger.scenes) {
      for (const [k, v] of Object.entries(s.scales)) {
        if (v.referencePixelDigest === digest) who.push(`${s.scene}@${k}`);
      }
    }
    const err = new Error(
      `refusing to run: input matches a sealed reference (${who.join(', ')}). ` +
      'The evaluator may only receive the degraded LR input.');
    err.code = 'REFERENCE_LEAK';
    throw err;
  }
}

function runOne(inputPath, outDir, scale, overrides, ledger, sceneName) {
  const inputBuf = fs.readFileSync(inputPath);
  const input = readPNG(inputBuf);
  refuseReference(input, ledger);

  // Optional: cross-check the digests in the matching recipe, when the input
  // was produced by tools/build_assets.js. A hand-edited file still runs, but
  // the report records that it is not byte-identical to the built asset.
  let provenance = { builtAsset: false };
  if (sceneName) {
    const recipe = require('./common').recipeFor(ledger, sceneName, scale);
    const inDigest = imageDigest(input);
    provenance = {
      builtAsset: inDigest === recipe.inputPixelDigest,
      inputPixelDigest: inDigest,
      expectedInputPixelDigest: recipe.inputPixelDigest,
    };
    if (!provenance.builtAsset) {
      console.warn(`warning: ${inputPath} does not match the built LR asset digest`);
    }
  }

  const result = runSuperResolution(input, scale, overrides);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'SR.png'), writePNG(result.sr));
  fs.writeFileSync(path.join(outDir, 'bicubic.png'), writePNG(result.bicubic));
  fs.writeFileSync(path.join(outDir, 'reprojected.png'), writePNG(result.reprojected));
  fs.writeFileSync(path.join(outDir, 'residual.png'), writePNG(result.residual));
  fs.writeFileSync(path.join(outDir, 'confidence.png'),
    writePNG(heatmap(result.confidenceMap, result.sr.width, result.sr.height)));
  fs.writeFileSync(path.join(outDir, 'transfer.png'),
    writePNG(transferOverlay(result.transferMap, result.sr.width, result.sr.height, result.sr)));

  const manifest = {
    input: path.resolve(inputPath),
    inputSize: [input.width, input.height],
    scale,
    scene: sceneName || null,
    outputSize: [result.sr.width, result.sr.height],
    params: result.params,
    defaults: DEFAULT_PARAMS,
    provenance,
    diagnostics: {
      elapsedMs: result.diagnostics.elapsedMs,
      residualRMS: result.residualRMS,
      residualMax: result.residualMax,
      steps: result.diagnostics.steps,
      rgbBackProjectionRMS: result.diagnostics.rgbBackProjectionRMS,
    },
    engine: 'selfsimilar-sr (zero-dependency, deterministic, no RNG in pipeline)',
    node: process.version,
  };
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'matches.json'), JSON.stringify({
    scale,
    params: result.params,
    matches: result.diagnostics.matchIndexFull,
  }));

  // Result object returned to the suite; it never contains the reference.
  return {
    scene: sceneName,
    scale,
    inputPath,
    inputSize: [input.width, input.height],
    outDir,
    result,
    provenance,
    inputDigest: imageDigest(input),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = loadLedger();
  const target = resolveTarget(args, ledger);
  try {
    const r = runOne(target.inputPath, target.outDir, target.scale, args.overrides, ledger, target.scene);
    console.log(JSON.stringify({
      ok: true,
      outDir: target.outDir,
      scene: r.scene,
      scale: r.scale,
      outputSize: [r.result.sr.width, r.result.sr.height],
      residualRMS: r.result.residualRMS,
      elapsedMs: r.result.diagnostics.elapsedMs,
      builtAsset: r.provenance.builtAsset,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, code: err.code || 'ERROR' }, null, 2));
    process.exit(err.code === 'REFERENCE_LEAK' ? 3 : 1);
  }
}

if (require.main === module) main();
module.exports = { runOne, refuseReference, parseArgs, coerce };
