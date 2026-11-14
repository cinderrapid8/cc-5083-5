'use strict';
// Suite runner: runs every scene/scale pair through the isolated evaluator,
// then (and only then) opens the sealed reference to score the result.
//
// The report deliberately includes failures, not just wins:
//   * region-level PSNR gain can be negative;
//   * per-block local residuals are reported for every block inside a region
//     so a copied-but-wrong decoy block is visible next to a correct one;
//   * `srWorseThanBicubic` is set wherever transfer hurt;
//   * the weak/low-similarity scenes are always included.
//
// Outputs per run (under runs/eval/<scene>_<scale>x/):
//   SR.png, bicubic.png, confidence.png, transfer.png, residual.png,
//   reprojected.png, run.json, matches.json   (from the isolated runner)
//   diff/                                   (produced after scoring)
//     <region>_sr.png, <region>_bicubic.png, <region>_ref.png
//     <region>_diff_sr.png, <region>_diff_bicubic.png
//   region_report.json
// plus suite_report.json + suite_report.md at runs/eval/.

const fs = require('fs');
const path = require('path');

const { ROOT, loadLedger, recipeFor } = require('./common');
const { runOne } = require('./run_eval');
const { regionStats, globalStats, regionDiffMaps, psnr } = require('./reference');
const { readPNG, writePNG, resample } = require('../engine');

const OUT_ROOT = path.join(ROOT, 'runs', 'eval');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// Default execution parameters for the suite. The GUI exposes the same
// knobs; these values keep a full suite run under a couple of minutes.
const SUITE_PARAMS = {
  patchStride: 6,
  shortlist: 10,
  backProjectionIters: 3,
  pyramidLevels: 3,
};

// Block-level residual inside a region. Blocks are aligned to the LR patch
// grid so the recorded confidence of each patch can be attributed to the
// exact HR pixels it influenced. Rect coordinates are in reference pixels;
// block size is patchSize * scale, which is the HR footprint of one LR patch.
function blockAnalysis(sr, bicubic, ref, rect, confMap, transferMap, scale, patchSize, threshold) {
  const [x0, y0, w, h] = rect;
  const block = patchSize * scale;
  const blocks = [];
  for (let by = y0; by + block <= y0 + h; by += block) {
    for (let bx = x0; bx + block <= x0 + w; bx += block) {
      let sseS = 0, sseB = 0, n = 0, confSum = 0, trSum = 0;
      for (let yy = by; yy < by + block; yy++) {
        for (let xx = bx; xx < bx + block; xx++) {
          const i = yy * ref.width + xx;
          for (let c = 0; c < 3; c++) {
            const ds = sr.planes[c][i] - ref.planes[c][i];
            const db = bicubic.planes[c][i] - ref.planes[c][i];
            sseS += ds * ds; sseB += db * db; n++;
          }
          confSum += confMap[i]; trSum += transferMap[i];
        }
      }
      const gainDb = 10 * Math.log10((255 * 255 / Math.max(1e-9, sseB / n)))
        - 10 * Math.log10((255 * 255 / Math.max(1e-9, sseS / n)));
      // rms residual, per block, on a 0..255 scale
      const rmsSR = Math.sqrt(sseS / n);
      const rmsBic = Math.sqrt(sseB / n);
      blocks.push({
        x: bx / scale, y: by / scale, block,
        meanConfidence: Number((confSum / (block * block)).toFixed(4)),
        transferFraction: Number((trSum / (block * block)).toFixed(4)),
        rmsSR: Number(rmsSR.toFixed(3)),
        rmsBicubic: Number(rmsBic.toFixed(3)),
        gainDb: Number(gainDb.toFixed(3)),
        // The two categories the task asks to surface side by side:
        // transfer applied AND made it worse.
        wrongTransfer: Number((trSum / (block * block) > 0.5 ? 1 : 0)) === 1
          && rmsSR > rmsBic + 0.02,
        gatedFallback: (confSum / (block * block)) < threshold,
      });
    }
  }
  return blocks;
}

function scoreRun(run, ledger, params) {
  const { scene, scale, outDir, result } = run;
  const entry = ledger.scenes.find((s) => s.scene === scene);
  // Reference is opened HERE, after reconstruction has completed.
  const recipe = recipeFor(ledger, scene, scale);
  const ref = readPNG(fs.readFileSync(path.join(ROOT, recipe.reference)));

  if (ref.width !== result.sr.width || ref.height !== result.sr.height) {
    throw new Error(`grid mismatch for ${scene}@${scale}x: reference ${ref.width}x${ref.height} `
      + `vs SR ${result.sr.width}x${result.sr.height}; refusing to compare misaligned grids`);
  }

  const g = globalStats(result.sr, result.bicubic, ref);
  const regions = [];
  const diffDir = path.join(outDir, 'diff');
  ensureDir(diffDir);

  for (const region of entry.regions) {
    const rect = region.rect.map(Number);
    const st = regionStats(result.sr, result.bicubic, ref, rect);
    const diffs = regionDiffMaps(result.sr, result.bicubic, ref, rect);
    const safe = region.name.replace(/[^a-z0-9_-]+/gi, '_');
    fs.writeFileSync(path.join(diffDir, `${safe}_sr.png`), writePNG(diffs.srCrop));
    fs.writeFileSync(path.join(diffDir, `${safe}_bicubic.png`), writePNG(diffs.bicubicCrop));
    fs.writeFileSync(path.join(diffDir, `${safe}_ref.png`), writePNG(diffs.refCrop));
    fs.writeFileSync(path.join(diffDir, `${safe}_diff_sr.png`), writePNG(diffs.srDiffMap));
    fs.writeFileSync(path.join(diffDir, `${safe}_diff_bicubic.png`), writePNG(diffs.bicubicDiffMap));

    const blocks = blockAnalysis(result.sr, result.bicubic, ref, rect,
      result.confidenceMap, result.transferMap, scale,
      result.params.patchSize, result.params.confidenceThreshold);

    regions.push({
      name: region.name,
      kind: region.kind,
      note: region.note,
      rect,
      ...st,
      blocks,
      wrongTransferBlocks: blocks.filter((b) => b.wrongTransfer).length,
      gatedBlocks: blocks.filter((b) => b.gatedFallback).length,
      blockCount: blocks.length,
    });
  }

  const report = {
    scene,
    family: entry.family,
    scale,
    referenceSize: [ref.width, ref.height],
    gridCheck: 'exact: reference and SR grids identical; regions whole multiples of the scale',
    global: g,
    params: result.params,
    observation: {
      residualRMS: result.residualRMS,
      residualMax: result.residualMax,
    },
    regions,
    elapsedMs: result.diagnostics.elapsedMs,
  };
  fs.writeFileSync(path.join(outDir, 'region_report.json'), JSON.stringify(report, null, 2));
  return report;
}

function fmt(n, digits = 2) {
  return Number(n).toFixed(digits);
}

function writeSummary(reports, params) {
  const rows = [];
  for (const r of reports) {
    const worst = r.regions.filter((x) => x.psnrGain < 0)
      .sort((a, b) => a.psnrGain - b.psnrGain).slice(0, 3);
    const wrong = r.regions.reduce((a, x) => a + x.wrongTransferBlocks, 0);
    rows.push({
      scene: r.scene,
      scale: r.scale,
      psnrSR: r.global.psnrSR,
      psnrBicubic: r.global.psnrBicubic,
      psnrGain: r.global.psnrGain,
      gradientErrorGain: r.global.gradientErrorGain,
      residualRMS: r.observation.residualRMS,
      wrongTransferBlocks: wrong,
      regionsWorse: r.regions.filter((x) => x.srWorseThanBicubic).map((x) => x.name),
      worstRegions: worst.map((x) => `${x.name} (${fmt(x.psnrGain)} dB)`),
    });
  }
  const doc = {
    note: 'Every scene/scale pair is included, including cases where self-similar '
      + 'transfer is worse than bicubic or copies detail into a decoy region.',
    runner: 'eval/run_eval.js (input-only; refuses sealed reference digests)',
    params,
    rows,
  };
  fs.writeFileSync(path.join(OUT_ROOT, 'suite_report.json'), JSON.stringify(doc, null, 2));

  const md = [];
  md.push('# Self-similarity asset suite — objective report');
  md.push('');
  md.push(`Parameters: ${JSON.stringify(params)}`);
  md.push('');
  md.push('| scene | scale | PSNR SR | PSNR bicubic | gain dB | gradErr gain | resid RMS | wrong-transfer blocks | regions worse |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    md.push(`| ${r.scene} | ${r.scale}x | ${fmt(r.psnrSR)} | ${fmt(r.psnrBicubic)} | `
      + `${r.psnrGain > 0 ? '+' : ''}${fmt(r.psnrGain)} | ${fmt(r.gradientErrorGain)} | `
      + `${fmt(r.residualRMS, 3)} | ${r.wrongTransferBlocks} | ${r.regionsWorse.join(', ') || '—'} |`);
  }
  md.push('');
  md.push('Negative gains and wrong-transfer blocks are reported, not filtered. '
    + 'A small or negative gain on the decoy/low-similarity regions is the expected honest outcome.');
  fs.writeFileSync(path.join(OUT_ROOT, 'suite_report.md'), md.join('\n'));
}

function main() {
  const argv = process.argv.slice(2);
  const scenes = [];
  const scales = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scene') scenes.push(argv[++i]);
    else if (argv[i] === '--scale') scales.push(Number(argv[++i]));
    else if (argv[i] === '--all') { scenes.length = 0; }
  }
  const ledger = loadLedger();
  const chosenScenes = scenes.length ? scenes : ledger.scenes.map((s) => s.scene);
  const chosenScales = scales.length ? scales : [2, 3, 4];
  ensureDir(OUT_ROOT);

  const reports = [];
  for (const scene of chosenScenes) {
    for (const scale of chosenScales) {
      const entry = ledger.scenes.find((s) => s.scene === scene);
      if (!entry.scales[`${scale}x`]) continue;
      const recipe = recipeFor(ledger, scene, scale);
      const outDir = path.join(OUT_ROOT, `${scene}_${scale}x`);
      const t = Date.now();
      const run = runOne(path.join(ROOT, recipe.input), outDir, scale,
        SUITE_PARAMS, ledger, scene);
      const report = scoreRun(run, ledger, SUITE_PARAMS);
      reports.push(report);
      const g = report.global;
      console.log(`${scene} ${scale}x: PSNR ${fmt(g.psnrSR)} vs ${fmt(g.psnrBicubic)} `
        + `(${g.psnrGain >= 0 ? '+' : ''}${fmt(g.psnrGain)} dB), `
        + `wrong-transfer blocks ${report.regions.reduce((a, r) => a + r.wrongTransferBlocks, 0)}, `
        + `${Date.now() - t} ms`);
    }
  }
  writeSummary(reports, SUITE_PARAMS);
  console.log(`wrote ${path.relative(ROOT, path.join(OUT_ROOT, 'suite_report.md'))}`);
}

if (require.main === module) main();
module.exports = { main, scoreRun, blockAnalysis, SUITE_PARAMS };
