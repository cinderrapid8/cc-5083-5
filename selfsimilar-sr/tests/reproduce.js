'use strict';
// One-shot reproducibility entry point: regenerates test inputs, runs every
// scene at the requested scale through the CLI-equivalent kernel call, and
// writes the full evaluation (metrics + every output image + match indexes).
// The HR reference is used only inside tests/evaluate.js for scoring.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateScene } = require('./evaluate');

function main() {
  const scale = Number(process.argv[2] || 2);
  const root = path.join(__dirname, '..');
  console.log('[1/3] regenerating deterministic synthetic inputs...');
  execFileSync(process.execPath, [path.join(root, 'tests', 'make_test_images.js')], { stdio: 'inherit' });

  console.log(`[2/3] evaluating all scenes at ${scale}x...`);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'inputs', 'manifest.json')));
  const outDir = path.join(__dirname, 'outputs', `scale${scale}`);
  const rows = [];
  for (const entry of manifest) {
    const { metrics, base } = evaluateScene(entry.lr, entry.hr, scale, {}, outDir);
    rows.push(metrics);
    console.log(`  ${base}: PSNR SR=${metrics.psnrSR} bicubic=${metrics.psnrBicubic} ` +
      `gain=${metrics.psnrGainVsBicubic}dB transfer=${metrics.transferFraction}`);
  }
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(rows, null, 2));

  console.log('[3/3] writing run manifests via CLI for one scene...');
  const cliOut = path.join(root, 'runs', `repro_scale${scale}`);
  execFileSync(process.execPath, [
    path.join(root, 'cli', 'run_sr.js'),
    manifest[0].lr, cliOut, '--scale', String(scale),
  ], { stdio: 'inherit' });
  console.log('done. outputs in', outDir, 'and', cliOut);
}

if (require.main === module) main();
