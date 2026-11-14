'use strict';
// Local self-similarity image-restoration window.
//
// The browser contains no image processing. Every control here maps to a
// parameter of the kernel in engine/, every preview image is produced by the
// kernel, and every anomaly shown in the UI is a measured property of the
// reconstruction (see engine/anomaly.js). Kernel failures travel back to the
// page and are displayed in the status area.
//
// Asset isolation: the page can load eval inputs from assets/inputs/**, but
// the server refuses to open any file under assets/references/**. The user
// can also upload an arbitrary PNG.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  readPNG, writePNG, runSuperResolution, heatmap, transferOverlay,
  extractCandidatePatch, DEFAULT_PARAMS, Image,
} = require('../engine');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const LEDGER_PATH = path.join(ASSETS, 'ledger.json');

const STATE = {
  input: null,       // decoded input Image (LR only)
  inputName: null,
  inputMeta: null,   // scene/scale when loaded from the asset suite
  lastResult: null,
  lastParams: null,
  lastScale: null,
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendPNG(res, buf) {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length,
    'cache-control': 'no-store' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 60 * 1024 * 1024) reject(new Error('upload too large (limit 60 MB)'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!m) throw new Error('missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  let start = buf.indexOf(boundary);
  if (start < 0) throw new Error('empty upload');
  start += boundary.length;
  const parts = [];
  while (true) {
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    let part = buf.subarray(start, next);
    if (part.length > 4) {
      if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
      const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd >= 0) {
        const header = part.subarray(0, headerEnd).toString('utf8');
        let data = part.subarray(headerEnd + 4);
        if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
          data = data.subarray(0, data.length - 2);
        }
        const nameM = /name="([^"]+)"/.exec(header);
        const fileM = /filename="([^"]*)"/.exec(header);
        parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : null, data });
      }
    }
    start = next + boundary.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
  }
  return parts;
}

function b64(img) {
  return writePNG(img).toString('base64');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

function makeResultPayload(result) {
  let confSum = 0;
  const n = result.confidenceMap.length;
  for (const v of result.confidenceMap) confSum += v;
  let tr = 0;
  for (const v of result.transferMap) if (v > 0.5) tr++;
  return {
    scale: result.scale,
    outputSize: [result.sr.width, result.sr.height],
    inputSize: [result.diagnostics.confidenceLRWidth, result.diagnostics.confidenceLRHeight],
    elapsedMs: result.diagnostics.elapsedMs,
    residualRMS: result.residualRMS,
    residualMax: result.residualMax,
    meanConfidence: Number((confSum / n).toFixed(4)),
    transferFraction: Number((tr / n).toFixed(4)),
    confidenceThreshold: result.params.confidenceThreshold,
    bpY: result.diagnostics.steps.map((s) => s.backProjectionRMS),
    bpRGB: result.diagnostics.rgbBackProjectionRMS,
    anomalies: result.anomalies,
    images: {
      sr: b64(result.sr),
      bicubic: b64(result.bicubic),
      reprojected: b64(result.reprojected),
      residual: b64(result.residual),
      confidence: b64(heatmap(result.confidenceMap, result.sr.width, result.sr.height)),
      transfer: b64(transferOverlay(result.transferMap, result.sr.width, result.sr.height, result.sr)),
    },
  };
}

// Serve only whitelisted asset subtrees. In particular assets/references is
// never reachable over HTTP: the clear answer stays out of the window.
function serveAsset(route, res) {
  const rel = route.replace(/^\/assets\//, '');
  if (rel.startsWith('references/')) {
    throw new Error('reference images are not served by the restoration window');
  }
  const decoded = decodeURIComponent(rel);
  const file = path.join(ASSETS, decoded);
  if (!file.startsWith(ASSETS)) throw new Error('bad asset path');
  if (!/\.(png|json|svg)$/.test(file)) throw new Error('unsupported asset type');
  if (!fs.existsSync(file)) throw new Error('asset not found: ' + decoded);
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function assetCatalog() {
  if (!fs.existsSync(LEDGER_PATH)) return { scenes: [] };
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  return {
    scenes: ledger.scenes.map((s) => ({
      name: s.scene,
      family: s.family,
      description: s.description,
      width: s.width,
      height: s.height,
      scales: Object.keys(s.scales),
      inputs: Object.fromEntries(Object.entries(s.scales).map(
        ([k, v]) => [k.replace('x', ''), v.input])),
      regions: s.regions.map((r) => ({ name: r.name, kind: r.kind, note: r.note })),
      editables: s.editables,
    })),
  };
}

// Draw the target patch and its candidates from the exact pyramid levels and
// rotations the matcher used. Each patch is nearest-neighbour magnified so the
// glyph/shape is visible without smoothing away the detail being judged.
function magnification(px, target = 96) {
  return Math.max(1, Math.round(target / px));
}

function patchTile(img, size) {
  const m = magnification(size);
  const out = new Image(img.width * m, img.height * m, img.channels);
  for (let c = 0; c < img.channels; c++) {
    for (let y = 0; y < out.height; y++) {
      const sy = Math.floor(y / m);
      for (let x = 0; x < out.width; x++) {
        out.planes[c][y * out.width + x] = img.planes[c][sy * img.width + Math.floor(x / m)];
      }
    }
  }
  return out;
}

function candidatePayload(record, result) {
  const p = result.params.patchSize;
  const pyramid = result.diagnostics.pyramid;
  const tx = record.target.x, ty = record.target.y;
  const lvl0 = pyramid[0].img;
  const target = new Image(p, p, 1);
  for (let y = 0; y < p; y++) {
    for (let x = 0; x < p; x++) {
      const sx = Math.min(lvl0.width - 1, tx + x);
      const sy = Math.min(lvl0.height - 1, ty + y);
      target.planes[0][y * p + x] = lvl0.planes[0][sy * lvl0.width + sx];
    }
  }
  const cands = record.candidates.map((c) => {
    const patch = extractCandidatePatch(pyramid, c, p);
    return {
      ...c,
      patchBase64: patch ? b64(patchTile(patch, p)) : null,
    };
  });
  return {
    target: { ...record.target, confidence: record.confidence, targetMean: record.targetMean },
    targetBase64: b64(patchTile(target, p)),
    candidates: cands,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html')));
    }
    if (req.method === 'GET' && route.startsWith('/web/')) {
      const file = path.join(ROOT, route);
      if (!file.startsWith(path.join(ROOT, 'web'))) throw new Error('bad path');
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && route.startsWith('/assets/')) {
      return serveAsset(route, res);
    }

    if (req.method === 'GET' && route === '/api/catalog') {
      const cat = assetCatalog();
      cat.defaults = DEFAULT_PARAMS;
      return sendJSON(res, 200, { ok: true, ...cat });
    }

    // Load a built LR input from the asset suite. Only inputs/** is allowed;
    // the reference tree is rejected before any file read.
    if (req.method === 'POST' && route === '/api/load-asset') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const scene = String(body.scene || '');
      const scale = Number(body.scale);
      const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      const entry = ledger.scenes.find((s) => s.scene === scene);
      if (!entry) throw new Error(`unknown scene ${scene}`);
      const rec = entry.scales[`${scale}x`];
      if (!rec) throw new Error(`scene ${scene} has no ${scale}x input`);
      const rel = rec.input;
      if (!rel.startsWith('assets/inputs/')) throw new Error('asset is not an input');
      const file = path.join(ROOT, rel);
      const img = readPNG(fs.readFileSync(file));
      STATE.input = img;
      STATE.inputName = `${scene}_${scale}x_LR.png`;
      STATE.inputMeta = { scene, scale, regions: entry.regions };
      STATE.lastResult = null;
      return sendJSON(res, 200, {
        ok: true,
        filename: STATE.inputName,
        width: img.width,
        height: img.height,
        channels: img.channels,
        scene,
        sceneScale: scale,
        pngBase64: b64(img),
      });
    }

    if (req.method === 'POST' && route === '/api/upload') {
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('multipart/form-data')) throw new Error('expected multipart upload');
      const body = await readBody(req);
      const parts = parseMultipart(body, ct);
      const file = parts.find((p) => p.filename);
      if (!file || !file.data.length) throw new Error('no file in upload');
      const img = readPNG(file.data);
      STATE.input = img;
      STATE.inputName = file.filename;
      STATE.inputMeta = null;
      STATE.lastResult = null;
      return sendJSON(res, 200, {
        ok: true,
        filename: file.filename,
        width: img.width,
        height: img.height,
        channels: img.channels,
        pngBase64: b64(img),
      });
    }

    if (req.method === 'POST' && route === '/api/run') {
      if (!STATE.input) throw new Error('load an input first (asset or upload)');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const scale = Number(body.scale) || 2;
      const overrides = body.params || {};
      const result = runSuperResolution(STATE.input, scale, overrides);
      STATE.lastResult = result;
      STATE.lastParams = result.params;
      STATE.lastScale = scale;
      return sendJSON(res, 200, { ok: true, ...makeResultPayload(result) });
    }

    if (req.method === 'GET' && route === '/api/result.png') {
      if (!STATE.lastResult) throw new Error('run the reconstruction first');
      const kind = url.searchParams.get('kind') || 'sr';
      const r = STATE.lastResult;
      const map = {
        sr: r.sr,
        bicubic: r.bicubic,
        reprojected: r.reprojected,
        residual: r.residual,
        confidence: heatmap(r.confidenceMap, r.sr.width, r.sr.height),
        transfer: transferOverlay(r.transferMap, r.sr.width, r.sr.height, r.sr),
        input: STATE.input,
      };
      if (!map[kind]) throw new Error('unknown result kind');
      return sendPNG(res, writePNG(map[kind]));
    }

    // Grid of target blocks the matcher actually evaluated.
    if (req.method === 'GET' && route === '/api/targets') {
      if (!STATE.lastResult) throw new Error('run the reconstruction first');
      const targets = STATE.lastResult.diagnostics.matchIndexFull.map((m) => ({
        x: m.target.x,
        y: m.target.y,
        size: m.target.size,
        confidence: m.confidence,
        transferred: m.confidence >= STATE.lastResult.params.confidenceThreshold,
        bestCost: m.candidates.length ? m.candidates[0].cost : null,
      }));
      const r = STATE.lastResult;
      return sendJSON(res, 200, {
        ok: true,
        patchSize: r.params.patchSize,
        lrWidth: r.diagnostics.confidenceLRWidth,
        lrHeight: r.diagnostics.confidenceLRHeight,
        threshold: r.params.confidenceThreshold,
        targets,
      });
    }

    // Exact candidate patches + cost breakdown for one evaluated target.
    if (req.method === 'GET' && route === '/api/candidates') {
      if (!STATE.lastResult) throw new Error('run the reconstruction first');
      const tx = Number(url.searchParams.get('x'));
      const ty = Number(url.searchParams.get('y'));
      const r = STATE.lastResult;
      const record = r.diagnostics.matchIndexFull.find(
        (m) => m.target.x === tx && m.target.y === ty);
      if (!record) {
        throw new Error(`no evaluated target at (${tx}, ${ty}); click a grid block`);
      }
      const payload = candidatePayload(record, r);
      payload.threshold = r.params.confidenceThreshold;
      payload.belowThreshold = record.confidence < r.params.confidenceThreshold;
      return sendJSON(res, 200, { ok: true, ...payload });
    }

    if (req.method === 'GET' && route === '/api/params') {
      return sendJSON(res, 200, { ok: true, defaults: DEFAULT_PARAMS,
        current: STATE.lastParams || DEFAULT_PARAMS });
    }

    if (req.method === 'POST' && route === '/api/sweep') {
      if (!STATE.input) throw new Error('load an input first');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const scale = Number(body.scale) || 2;
      const key = String(body.param || 'confidenceThreshold');
      const values = Array.isArray(body.values) ? body.values : [];
      const rows = [];
      for (const value of values) {
        const overrides = { [key]: Number(value) };
        const r = runSuperResolution(STATE.input, scale, overrides);
        let cs = 0, tc = 0;
        for (const v of r.confidenceMap) cs += v;
        for (const v of r.transferMap) if (v > 0.5) tc++;
        rows.push({
          value,
          residualRMS: r.residualRMS,
          meanConfidence: Number((cs / r.confidenceMap.length).toFixed(4)),
          transferFraction: Number((tc / r.transferMap.length).toFixed(4)),
          anomalyCount: r.anomalies.length,
          worstAnomaly: r.anomalies.length ? r.anomalies[0].kind : null,
          srBase64: b64(r.sr),
        });
      }
      return sendJSON(res, 200, { ok: true, param: key, rows });
    }

    // Editable scene spec / SVG export, served from assets/scenes.
    if (req.method === 'GET' && route === '/api/scene-editables') {
      const cat = assetCatalog();
      return sendJSON(res, 200, { ok: true, scenes: cat.scenes.map((s) => ({
        name: s.name, family: s.family, editables: s.editables,
      })) });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    sendJSON(res, 400, { ok: false, error: err.message,
      stack: (err.stack || '').split('\n').slice(0, 3) });
  }
});

function start(port = 8123) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      console.log(`self-similarity restoration window: http://localhost:${port}/`);
      console.log('reference images are not served; only inputs are loadable');
      resolve(server);
    });
  });
}

if (require.main === module) start(Number(process.argv[2] || 8123));
module.exports = { server, start };
