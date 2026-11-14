'use strict';
// Verification of the self-similarity evaluation package.
//
// Run: node tools/verify.js
//
// Checks, in order:
//   1. every scene definition passes the scale/crop-relationship checks;
//   2. a clean rebuild reproduces the sealed reference/input digests exactly
//      (rebuild determinism);
//   3. each built LR input is exactly `referenceSize / scale` and the recipe
//      records that crop;
//   4. the isolated runner refuses a sealed reference even when it is renamed;
//   5. no reference image is reachable through the HTTP window;
//   6. the engine is deterministic and its luminance-only-chroma invariant
//      holds on a real run.
//
// Exits non-zero on the first hard failure and prints a machine-readable
// summary at the end.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const {
  readPNG, degrade, runSuperResolution, rgbToYCbCr,
} = require('../engine');
const { loadScene, listScenes, renderScene, resolveOps } = require('../scenes/lib/scene');
const { RASTER_TYPES, renderPrefix, opBounds } = require('../scenes/lib/svg');
const { imageDigest, loadLedger, recipeFor } = require('../eval/common');
const { checkScene } = require('./build_assets');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function main() {
  const ledger = loadLedger();
  const names = listScenes();

  // 1. Scene definition checks.
  let sceneOk = true, sceneDetail = '';
  for (const name of names) {
    const scene = loadScene(name);
    const errs = checkScene(scene, [2, 3, 4]);
    if (errs.length) { sceneOk = false; sceneDetail += `${name}: ${errs.join('; ')} `; }
  }
  record('scene definitions pass scale/crop checks', sceneOk, sceneDetail.trim());

  // 2. Rebuild determinism: rebuild to a scratch tree and compare digests.
  const tmp = path.join(ROOT, '.verify-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  // Rebuild into a temporary mirror by re-running the generator with a
  // relocated output is more than needed; instead re-render in memory and
  // compare against the sealed digests. This catches any drift in the
  // rasteriser, PRNG or degradation recipe.
  let rebuildOk = true, rebuildDetail = '';
  for (const entry of ledger.scenes) {
    const scene = loadScene(entry.scene);
    const { image: hr } = renderScene(scene);
    for (const [scaleKey, rec] of Object.entries(entry.scales)) {
      const scale = Number(scaleKey.replace('x', ''));
      const recipe = recipeFor(ledger, entry.scene, scale);
      const lr = degrade(hr, scale, recipe.degradation.blur.sigma);
      const hrDigest = imageDigest(hr);
      const lrDigest = imageDigest(lr);
      if (hrDigest !== rec.referencePixelDigest) {
        rebuildOk = false;
        rebuildDetail += `${entry.scene}@${scaleKey} HR digest drifted; `;
      }
      if (lrDigest !== recipe.inputPixelDigest) {
        rebuildOk = false;
        rebuildDetail += `${entry.scene}@${scaleKey} LR digest drifted; `;
      }
    }
  }
  record('rebuild reproduces sealed reference and input digests', rebuildOk, rebuildDetail.trim());

  // 3. Scale and crop relationship.
  let gridOk = true, gridDetail = '';
  for (const entry of ledger.scenes) {
    for (const [scaleKey, rec] of Object.entries(entry.scales)) {
      const scale = Number(scaleKey.replace('x', ''));
      const recipe = recipeFor(ledger, entry.scene, scale);
      const lr = readPNG(fs.readFileSync(path.join(ROOT, recipe.input)));
      const expectW = entry.width / scale;
      const expectH = entry.height / scale;
      if (lr.width !== expectW || lr.height !== expectH) {
        gridOk = false;
        gridDetail += `${entry.scene}@${scaleKey} ${lr.width}x${lr.height} != ${expectW}x${expectH}; `;
      }
      if (recipe.crop.w !== entry.width || recipe.crop.h !== entry.height
        || recipe.crop.x !== 0 || recipe.crop.y !== 0) {
        gridOk = false;
        gridDetail += `${entry.scene}@${scaleKey} crop is not the full-frame reference; `;
      }
      // Regions must be whole multiples so local metrics align.
      for (const region of entry.regions) {
        const [x, y, w, h] = region.rect;
        if (x % scale || y % scale || w % scale || h % scale) {
          gridOk = false;
          gridDetail += `${entry.scene}@${scaleKey} region ${region.name} not scale-aligned; `;
        }
      }
    }
  }
  record('input grids and region crops align to the scale', gridOk, gridDetail.trim());

  // 3b. Editable scene exports (JSON + SVG) match the resolved scene.
  let svgOk = true, svgDetail = '';
  for (const entry of ledger.scenes) {
    const scene = loadScene(entry.scene);
    const specPath = path.join(ROOT, entry.editables.spec);
    const svgPath = path.join(ROOT, entry.editables.svg);
    if (!fs.existsSync(specPath) || !fs.existsSync(svgPath)) {
      svgOk = false; svgDetail += `${entry.scene}: missing editable export; `; continue;
    }
    let spec;
    try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch {
      svgOk = false; svgDetail += `${entry.scene}: spec is not valid JSON; `; continue;
    }
    const ops = resolveOps(scene);
    if (spec.ops.length !== ops.length || spec.width !== entry.width || spec.height !== entry.height) {
      svgOk = false;
      svgDetail += `${entry.scene}: spec has ${spec.ops.length} ops, scene resolves to ${ops.length}; `;
    }
    const svg = fs.readFileSync(svgPath, 'utf8');
    if (!/^<\?xml/.test(svg) || !/<svg[\s>]/i.test(svg) || !svg.trim().endsWith('</svg>')) {
      svgOk = false; svgDetail += `${entry.scene}: SVG is not a complete XML document; `; continue;
    }
    const rasters = ops.filter((o) => RASTER_TYPES.has(o.type));
    const images = [...svg.matchAll(/<image x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)];
    if (images.length !== rasters.length) {
      svgOk = false;
      svgDetail += `${entry.scene}: ${images.length} raster patches for ${rasters.length} raster ops; `;
    }
    // Each patch must sit at the floor/ceil bounds of its op and carry the
    // exact crop of the reference render at that point.
    let rasterIdx = 0;
    ops.forEach((op, opIdx) => {
      if (!RASTER_TYPES.has(op.type)) return;
      const im = images[rasterIdx++];
      if (!im) return;
      const [bx, by, bw, bh] = opBounds(op, entry.width, entry.height);
      if (+im[1] !== bx || +im[2] !== by || +im[3] !== bw || +im[4] !== bh) {
        svgOk = false;
        svgDetail += `${entry.scene}: patch at ${im[1]},${im[2]} ${im[3]}x${im[4]} `
          + `!= op bounds ${bx},${by} ${bw}x${bh}; `;
        return;
      }
      const m = /<image x="\d+" y="\d+" width="\d+" height="\d+" href="data:image\/png;base64,([^"]+)"/g;
      m.lastIndex = 0;
      let b64 = null;
      for (let k = 0; k <= rasterIdx - 1; k++) {
        const hit = m.exec(svg);
        if (hit) b64 = hit[1];
      }
      if (!b64) {
        svgOk = false; svgDetail += `${entry.scene}: no embedded PNG for patch; `; return;
      }
      const { readPNG } = require('../engine/png');
      const patch = readPNG(Buffer.from(b64, 'base64'));
      const expect = renderPrefix(scene, ops, opIdx).subImage(bx, by, bw, bh);
      let maxd = 0;
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < bw * bh; i++) {
          // The embedded PNG stores 8-bit levels; compare after the same
          // rounding the encoder applies.
          const want = Math.round(Math.max(0, Math.min(255, expect.planes[c][i])));
          maxd = Math.max(maxd, Math.abs(patch.planes[c][i] - want));
        }
      }
      if (patch.width !== bw || patch.height !== bh || maxd > 0) {
        svgOk = false;
        svgDetail += `${entry.scene}: patch pixels differ from render (max ${maxd}); `;
      }
    });
  }
  record('editable JSON/SVG exports match the resolved scene', svgOk, svgDetail.trim());

  // 4. Reference isolation: rename HR.png to a neutral name and attempt a run
  //    in a child process; it must refuse (exit code 3).
  let leakOk = true, leakDetail = '';
  {
    const entry = ledger.scenes[0];
    const recipe = recipeFor(ledger, entry.scene, 2);
    const hrPath = path.join(ROOT, recipe.reference);
    const disguised = path.join(tmp, 'input_candidate.png');
    fs.copyFileSync(hrPath, disguised);
    let out, code = 0;
    try {
      out = execFileSync(process.execPath,
        [path.join(__dirname, '..', 'eval', 'run_eval.js'), disguised, path.join(tmp, 'out'), '--scale', '2'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      code = err.status;
      out = (err.stdout || '') + (err.stderr || '');
    }
    if (code !== 3 || !/sealed reference/.test(out)) {
      leakOk = false;
      leakDetail = `expected refusal exit 3, got ${code}: ${out.slice(0, 200)}`;
    }
    if (fs.existsSync(path.join(tmp, 'out'))) {
      leakOk = false;
      leakDetail += ' runner wrote output for a refused reference;';
    }
  }
  record('runner refuses a renamed sealed reference', leakOk, leakDetail.trim());

  // 5. HTTP isolation: start the server on an ephemeral port and ask for a
  //    reference and an input. Reference must be refused, input allowed.
  let httpOk = true, httpDetail = '';
  {
    const { server, start } = require('../cli/server');
    // Port 0 asks the OS for a free port, so verification never collides with
    // a window the user already has open.
    start(0).then(async (srv) => {
      const port = srv.address().port;
      try {
        const http = require('http');
        const get = (p) => new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
          }).on('error', reject);
        });
        const ref = await get('/assets/references/facade/2x/HR.png');
        const inp = await get('/assets/inputs/facade/2x/LR.png');
        if (ref.status === 200) { httpOk = false; httpDetail += 'reference was served; '; }
        if (inp.status !== 200) { httpOk = false; httpDetail += 'input was not served; '; }
        else if (inp.body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
          httpOk = false; httpDetail += 'input response is not a PNG; ';
        }
        if (ref.status === 200
          && ref.body.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
          httpOk = false; httpDetail += 'reference PNG body leaked; ';
        }
      } catch (err) {
        httpOk = false; httpDetail += err.message;
      } finally {
        server.close();
        record('HTTP window serves inputs but never references', httpOk, httpDetail.trim());
        finish(tmp);
      }
    }).catch((err) => {
      record('HTTP window serves inputs but never references', false, err.message);
      finish(tmp);
    });
  }
}

function finish(tmp) {
  // 6. Engine invariants on a real run: determinism + chroma frozen.
  let invariantsOk = true, invariantsDetail = '';
  const ledger = loadLedger();
  const recipe = recipeFor(ledger, 'facade', 2);
  const input = readPNG(fs.readFileSync(path.join(ROOT, recipe.input)));
  const opts = { patchStride: 8, backProjectionIters: 2, shortlist: 8 };
  const a = runSuperResolution(input, 2, opts);
  const b = runSuperResolution(input, 2, opts);
  let maxd = 0;
  for (let c = 0; c < 3; c++) for (let i = 0; i < a.sr.planes[0].length; i++) {
    maxd = Math.max(maxd, Math.abs(a.sr.planes[c][i] - b.sr.planes[c][i]));
  }
  if (maxd !== 0) { invariantsOk = false; invariantsDetail += `non-deterministic (maxdiff ${maxd}); `; }

  // Chroma must equal the bicubic baseline's chroma to within the RGB
  // round-trip tolerance (back-projection is luminance-only).
  const yA = rgbToYCbCr(a.sr), yB = rgbToYCbCr(a.bicubic);
  let chromaMax = 0;
  for (let i = 0; i < yA.planes[1].length; i++) {
    chromaMax = Math.max(chromaMax,
      Math.hypot(yA.planes[1][i] - yB.planes[1][i], yA.planes[2][i] - yB.planes[2][i]));
  }
  if (chromaMax > 8) { invariantsOk = false; invariantsDetail += `chroma drifted ${chromaMax.toFixed(2)}; `; }

  // Confidence and transfer maps are shown as fractions, so they must stay in
  // [0,1] after the upscale (bicubic overshoot used to leak values like 1.15).
  for (const [name, arr] of [['confidence', a.confidenceMap], ['transfer', a.transferMap]]) {
    let bad = 0;
    for (const v of arr) if (!(v >= 0 && v <= 1)) bad++;
    if (bad) { invariantsOk = false; invariantsDetail += `${bad} ${name} values outside [0,1]; `; }
  }

  record('engine is deterministic and chroma stays on the bicubic baseline', invariantsOk,
    invariantsDetail.trim());

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) main();
