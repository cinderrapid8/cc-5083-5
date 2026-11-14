'use strict';
// Build the self-similarity evaluation asset suite.
//
// For every scene this script writes two separated sets of files:
//
//   references/<scene>/<scale>x/HR.png   clear reference (evaluation only)
//   inputs/<scene>/<scale>x/LR.png       the only file the SR runner may open
//
// The reference and the input live on different paths and are additionally
// guarded by eval/ledger.json, which records the SHA-256 of every reference.
// The runner never receives, and cannot derive, the reference path from the
// input path: eval/run_eval.js accepts only input files and refuses any file
// whose digest appears in the ledger. The HR file is only opened by the
// evaluator after the reconstruction has finished.
//
// Usage:
//   node tools/build_assets.js                # build everything
//   node tools/build_assets.js --clean        # wipe generated outputs first
//   node tools/build_assets.js --scene facade --scale 2

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writePNG } = require('../engine/png');
const { degrade } = require('../engine/image');
const { loadScene, listScenes, renderScene } = require('../scenes/lib/scene');
const { sceneToSVG, sceneToJSON } = require('../scenes/lib/svg');
const { imageDigest } = require('../eval/common');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const REF_DIR = path.join(ASSETS, 'references');
const INPUT_DIR = path.join(ASSETS, 'inputs');
const SCENE_DIR = path.join(ASSETS, 'scenes');
const RECIPE_DIR = path.join(ASSETS, 'recipes');
const LEDGER_PATH = path.join(ASSETS, 'ledger.json');

// Scales written for the GUI scale selector. 2/3/4 all divide the scene
// dimensions, so an exact integer downscale exists for each.
const SCALES = [2, 3, 4];

// Degradation is the same model the engine implements for building its
// pyramid and for projecting the reconstruction back: Gaussian blur then
// bicubic downscale. The blur sigma grows slightly with scale so the LR
// observation stays a fair, non-trivial inverse problem at every factor.
const DEGRADE = {
  2: { sigma: 1.0, kernel: 'gaussian', resample: 'catmull-rom-bicubic' },
  3: { sigma: 1.15, kernel: 'gaussian', resample: 'catmull-rom-bicubic' },
  4: { sigma: 1.3, kernel: 'gaussian', resample: 'catmull-rom-bicubic' },
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}



function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// A scene is runnable if every declared region lies inside the frame and the
// reference dimensions divide exactly by all generated scales. A partial
// overlap or a 1-pixel rounding mismatch would make the pixel-aligned
// comparison unfair, so build fails loudly instead of writing a bad asset.
function checkScene(scene, scales) {
  const errors = [];
  for (const s of scales) {
    if (scene.width % s !== 0 || scene.height % s !== 0) {
      errors.push(`dims ${scene.width}x${scene.height} not divisible by ${s}`);
    }
  }
  const regs = scene.regions || [];
  if (!regs.length) errors.push('scene declares no regions');
  const seen = new Set();
  for (const r of regs) {
    if (seen.has(r.name)) errors.push(`duplicate region name ${r.name}`);
    seen.add(r.name);
    if (!r.kind) errors.push(`region ${r.name} has no kind`);
    const [x, y, w, h] = r.rect || [];
    if (!(w > 0 && h > 0)) { errors.push(`region ${r.name} has empty rect`); continue; }
    if (x < 0 || y < 0 || x + w > scene.width || y + h > scene.height) {
      errors.push(`region ${r.name} rect ${r.rect} outside ${scene.width}x${scene.height}`);
    }
    // Regions must map to whole LR pixels for each scale, otherwise the
    // local residual reported for that region would mix in neighbouring
    // content. This is the crop-relationship check the task asks for.
    for (const s of scales) {
      if (x % s !== 0 || y % s !== 0 || w % s !== 0 || h % s !== 0) {
        errors.push(`region ${r.name} rect ${r.rect} is not a whole ${s}x multiple`);
      }
    }
  }
  return errors;
}

function buildScene(name, scales) {
  const scene = loadScene(name);
  const errors = checkScene(scene, scales);
  if (errors.length) {
    throw new Error(`scene ${name} is not runnable:\n  ` + errors.join('\n  '));
  }
  const { image: hr, ops } = renderScene(scene);

  // Editable spec is written verbatim; the rasteriser reads only this file.
  const scenePath = path.join(SCENE_DIR, `${name}.json`);
  ensureDir(SCENE_DIR);
  fs.writeFileSync(scenePath, sceneToJSON(name, scene, ops));
  const svgPath = path.join(SCENE_DIR, `${name}.svg`);
  fs.writeFileSync(svgPath, sceneToSVG(name, scene));

  const ledger = {
    scene: name,
    family: scene.family,
    description: scene.description,
    width: scene.width,
    height: scene.height,
    editables: {
      spec: path.relative(ROOT, scenePath),
      svg: path.relative(ROOT, svgPath),
    },
    regions: scene.regions,
    scales: {},
  };

  for (const scale of scales) {
    const refDir = path.join(REF_DIR, name, `${scale}x`);
    const inDir = path.join(INPUT_DIR, name, `${scale}x`);
    ensureDir(refDir);
    ensureDir(inDir);

    const recipe = DEGRADE[scale];
    const lr = degrade(hr, scale, recipe.sigma);

    // Sanity: the degraded grid must exactly match width/scale.
    if (lr.width !== scene.width / scale || lr.height !== scene.height / scale) {
      throw new Error(`degrade grid mismatch for ${name}@${scale}x: ` +
        `${lr.width}x${lr.height} != ${scene.width / scale}x${scene.height / scale}`);
    }

    const refPng = writePNG(hr);
    const lrPng = writePNG(lr);
    fs.writeFileSync(path.join(refDir, 'HR.png'), refPng);
    fs.writeFileSync(path.join(inDir, 'LR.png'), lrPng);

    const recipeObj = {
      scene: name,
      scale,
      reference: path.relative(ROOT, path.join(refDir, 'HR.png')),
      input: path.relative(ROOT, path.join(inDir, 'LR.png')),
      referenceSize: [scene.width, scene.height],
      inputSize: [lr.width, lr.height],
      crop: { x: 0, y: 0, w: scene.width, h: scene.height },
      degradation: {
        blur: { kernel: recipe.kernel, sigma: recipe.sigma, edge: 'clamp' },
        downsample: { method: recipe.resample, factor: scale, grid: 'pixel-centre-aligned' },
        colour: 'sRGB channelwise, applied before engine YCbCr conversion',
      },
      referenceSha256: sha256(refPng),
      inputSha256: sha256(lrPng),
      referencePixelDigest: imageDigest(hr),
      inputPixelDigest: imageDigest(lr),
    };
    ensureDir(RECIPE_DIR);
    writeJSON(path.join(RECIPE_DIR, `${name}_${scale}x.json`), recipeObj);

    ledger.scales[`${scale}x`] = {
      input: path.relative(ROOT, recipeObj.input),
      reference: path.relative(ROOT, recipeObj.reference),
      recipe: path.relative(ROOT, path.join(RECIPE_DIR, `${name}_${scale}x.json`)),
      referencePixelDigest: recipeObj.referencePixelDigest,
      inputPixelDigest: recipeObj.inputPixelDigest,
    };
  }

  return ledger;
}

function writeLedger(ledgers) {
  ensureDir(ASSETS);
  const doc = {
    note: 'Reference digests are sealed here. eval/run_eval.js refuses as input '
      + 'any file whose pixel digest appears in this ledger, so the runner '
      + 'cannot be pointed at a clear reference.',
    drawingsOnly: 'All references are generated by tools/build_assets.js from '
      + 'scenes/defs/*.js; no third-party image is used.',
    scenes: ledgers,
  };
  writeJSON(LEDGER_PATH, doc);
}

function main() {
  const argv = process.argv.slice(2);
  const clean = argv.includes('--clean');
  const only = [];
  const scales = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scene') only.push(argv[++i]);
    else if (argv[i] === '--scale') scales.push(Number(argv[++i]));
  }
  const chosenScales = scales.length ? scales : SCALES;
  const names = only.length ? only : listScenes();

  if (clean) {
    for (const d of ['references', 'inputs', 'recipes', 'scenes']) rmrf(path.join(ASSETS, d));
    rmrf(LEDGER_PATH);
  }
  ensureDir(ASSETS);
  ensureDir(REF_DIR);
  ensureDir(INPUT_DIR);

  const ledgers = [];
  for (const name of names) {
    const t = Date.now();
    const ledger = buildScene(name, chosenScales);
    ledgers.push(ledger);
    console.log(`  built ${name}: ${Object.keys(ledger.scales).join(', ')} (${Date.now() - t} ms)`);
  }
  writeLedger(ledgers);

  // Drawing manifest, separate from the sealed reference ledger. Besides the
  // scene/editables listing it is the processing checklist: for every
  // scene/scale it names the input, reference and recipe file plus the exact
  // degradation parameters used to derive one from the other.
  const manifest = {
    generatedBy: 'tools/build_assets.js',
    rebuild: 'node tools/build_assets.js --clean',
    verify: 'node tools/verify.js',
    degradationModel: 'gaussian blur (clamped edges) -> catmull-rom bicubic downsample, integer factor',
    isolation: 'references/ and inputs/ are separate trees; eval/run_eval.js refuses any '
      + 'file whose pixel digest is sealed in ledger.json; the GUI never serves references/',
    scenes: ledgers.map((l) => ({
      name: l.scene, family: l.family, size: [l.width, l.height],
      editables: l.editables,
      regions: l.regions,
      scales: Object.keys(l.scales),
      assets: Object.entries(l.scales).map(([k, v]) => {
        const scale = Number(k.replace('x', ''));
        return {
          scale,
          input: v.input,
          reference: v.reference,
          recipe: v.recipe,
          referencePixelDigest: v.referencePixelDigest,
          inputPixelDigest: v.inputPixelDigest,
          degradation: DEGRADE[scale],
        };
      }),
    })),
  };
  writeJSON(path.join(ASSETS, 'manifest.json'), manifest);
  console.log(`wrote ledger (${ledgers.length} scenes) to ${path.relative(ROOT, LEDGER_PATH)}`);
}

if (require.main === module) main();
module.exports = { buildScene, checkScene, SCALES, DEGRADE, LEDGER_PATH };
