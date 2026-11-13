'use strict';
// Evaluation ONLY. The HR reference image is loaded in this script and is
// never passed to the SR engine or used in candidate search. Metrics compare
// the self-similarity result and the bicubic baseline against the reference
// on the identical HR grid.

const fs = require('fs');
const path = require('path');
const { readPNG, runSuperResolution, writePNG, Image, resample,
  heatmap, transferOverlay, mean, fraction } = require('../engine');

function psnr(a, b) {
  let s = 0, n = 0;
  for (let c = 0; c < a.channels; c++) {
    for (let i = 0; i < a.planes[0].length; i++) {
      const d = a.planes[c][i] - b.planes[c][i];
      s += d * d; n++;
    }
  }
  const mse = s / n;
  if (mse < 1e-12) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

// Mean gradient-magnitude error: rewards/penalises edge reconstruction
// independently of flat-region tone differences.
function gradientError(a, b) {
  const w = a.width, h = a.height;
  function grad(img) {
    const g = new Float64Array(w * h);
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        const gx = img.planes[0][i + 1] - img.planes[0][i];
        const gy = img.planes[0][i + w] - img.planes[0][i];
        g[i] = Math.hypot(gx, gy);
      }
    }
    return g;
  }
  const ga = grad(a), gb = grad(b);
  let s = 0;
  for (let i = 0; i < ga.length; i++) s += Math.abs(ga[i] - gb[i]);
  return s / ga.length;
}

function evaluateScene(inputPath, refPath, scale, overrides, outDir) {
  const input = readPNG(fs.readFileSync(inputPath));
  const reference = readPNG(fs.readFileSync(refPath));
  const result = runSuperResolution(input, scale, overrides);
  const targetW = result.sr.width, targetH = result.sr.height;
  // Reference is resampled to the output grid solely for metric alignment.
  const refOnGrid = reference.width === targetW && reference.height === targetH
    ? reference : resample(reference, targetW, targetH);
  const bicubicOnGrid = result.bicubic;

  const metrics = {
    scene: path.basename(inputPath),
    scale,
    size: [targetW, targetH],
    psnrSR: Number(psnr(result.sr, refOnGrid).toFixed(3)),
    psnrBicubic: Number(psnr(bicubicOnGrid, refOnGrid).toFixed(3)),
    gradientErrorSR: Number(gradientError(result.sr, refOnGrid).toFixed(3)),
    gradientErrorBicubic: Number(gradientError(bicubicOnGrid, refOnGrid).toFixed(3)),
    observationResidualRMS: result.residualRMS,
    observationResidualMax: result.residualMax,
    meanConfidence: Number(mean(result.confidenceMap).toFixed(3)),
    transferFraction: Number(fraction(result.transferMap, 0.5).toFixed(3)),
    elapsedMs: result.diagnostics.elapsedMs,
  };
  metrics.psnrGainVsBicubic = Number((metrics.psnrSR - metrics.psnrBicubic).toFixed(3));

  const base = path.basename(inputPath, path.extname(inputPath));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${base}_SR.png`), writePNG(result.sr));
  fs.writeFileSync(path.join(outDir, `${base}_bicubic.png`), writePNG(result.bicubic));
  fs.writeFileSync(path.join(outDir, `${base}_reprojected.png`), writePNG(result.reprojected));
  fs.writeFileSync(path.join(outDir, `${base}_residual.png`), writePNG(result.residual));
  fs.writeFileSync(path.join(outDir, `${base}_confidence.png`),
    writePNG(heatmap(result.confidenceMap, targetW, targetH)));
  fs.writeFileSync(path.join(outDir, `${base}_transfer.png`),
    writePNG(transferOverlay(result.transferMap, targetW, targetH, result.sr)));
  return { metrics, result, base };
}

module.exports = { evaluateScene, psnr, gradientError };

if (require.main === module) {
  const scale = Number(process.argv[2] || 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'inputs', 'manifest.json')));
  const outDir = path.join(__dirname, 'outputs', `scale${scale}`);
  const all = [];
  for (const entry of manifest) {
    const { metrics } = evaluateScene(entry.lr, entry.hr, scale, {}, outDir);
    all.push(metrics);
    console.log(metrics);
  }
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(all, null, 2));
  console.log('wrote metrics and images to', outDir);
}
