'use strict';
// Local web GUI server. All controls are served by the self-similarity
// kernel in engine/: the browser only renders results. If the kernel throws,
// the error is returned to the UI and shown as failure feedback — the page
// never invents its own image processing.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  readPNG, writePNG, runSuperResolution, Image, resample, heatmap, transferOverlay,
  DEFAULT_PARAMS,
} = require('../engine');

const STATE = {
  input: null,        // decoded Image
  inputName: null,
  lastResult: null,   // full SR result object
  lastParams: null,
  lastScale: null,
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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
      if (size > 50 * 1024 * 1024) reject(new Error('upload too large (limit 50 MB)'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Very small multipart/form-data parser sufficient for one file field.
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

function imageToDataPayload(img) {
  return writePNG(img).toString('base64');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }
    if (req.method === 'GET' && route.startsWith('/web/')) {
      const file = path.join(__dirname, '..', route);
      if (!file.startsWith(path.join(__dirname, '..', 'web'))) throw new Error('bad path');
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
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
      STATE.lastResult = null;
      return sendJSON(res, 200, { ok: true, filename: file.filename,
        width: img.width, height: img.height, channels: img.channels,
        pngBase64: imageToDataPayload(img) });
    }

    if (req.method === 'POST' && route === '/api/run') {
      if (!STATE.input) throw new Error('upload an image first');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const scale = Number(body.scale) || 2;
      if (!(scale >= 1 && scale <= 4)) throw new Error('scale must be in [1, 4]');
      const overrides = body.params || {};
      const result = runSuperResolution(STATE.input, scale, overrides);
      STATE.lastResult = result;
      STATE.lastParams = result.params;
      STATE.lastScale = scale;
      let confSum = 0, trCount = 0;
      for (const v of result.confidenceMap) confSum += v;
      for (const v of result.transferMap) if (v > 0.5) trCount++;
      const n = result.confidenceMap.length;
      return sendJSON(res, 200, {
        ok: true,
        scale,
        outputSize: [result.sr.width, result.sr.height],
        elapsedMs: result.diagnostics.elapsedMs,
        residualRMS: result.residualRMS,
        residualMax: result.residualMax,
        meanConfidence: Number((confSum / n).toFixed(4)),
        transferFraction: Number((trCount / n).toFixed(4)),
        bpY: result.diagnostics.steps.map((s) => s.backProjectionRMS),
        bpRGB: result.diagnostics.rgbBackProjectionRMS,
        images: {
          sr: imageToDataPayload(result.sr),
          bicubic: imageToDataPayload(result.bicubic),
          reprojected: imageToDataPayload(result.reprojected),
          residual: imageToDataPayload(result.residual),
          confidence: imageToDataPayload(heatmap(result.confidenceMap, result.sr.width, result.sr.height)),
          transfer: imageToDataPayload(transferOverlay(result.transferMap, result.sr.width, result.sr.height, result.sr)),
        },
      });
    }

    if (req.method === 'GET' && route === '/api/result.png') {
      if (!STATE.lastResult) throw new Error('run the reconstruction first');
      const kind = url.searchParams.get('kind') || 'sr';
      const r = STATE.lastResult;
      const map = {
        sr: r.sr, bicubic: r.bicubic, reprojected: r.reprojected, residual: r.residual,
        confidence: heatmap(r.confidenceMap, r.sr.width, r.sr.height),
        transfer: transferOverlay(r.transferMap, r.sr.width, r.sr.height, r.sr),
      };
      if (!map[kind]) throw new Error('unknown result kind');
      return sendPNG(res, writePNG(map[kind]));
    }

    // Local candidate inspection for one LR target patch.
    if (req.method === 'GET' && route === '/api/candidates') {
      if (!STATE.lastResult) throw new Error('run the reconstruction first');
      const tx = Number(url.searchParams.get('x'));
      const ty = Number(url.searchParams.get('y'));
      const r = STATE.lastResult;
      const p = r.params.patchSize;
      const record = r.diagnostics.matchIndexFull.find(
        (m) => m.target.x === tx && m.target.y === ty);
      if (!record) throw new Error(`no target at (${tx}, ${ty}); nearest grid positions only`);
      // Re-extract the target and each candidate patch as PNGs for display.
      const lr = STATE.input;
      const targetPng = writePNG(lr.subImage(tx, ty, p, p)).toString('base64');
      const candidatePngs = record.candidates.map((c) => {
        const patch = lr.subImage(c.x, c.y, c.w, c.h);
        return { ...c, pngBase64: writePNG(resample(patch, p * 6, p * 6)).toString('base64') };
      });
      const targetLarge = writePNG(resample(lr.subImage(tx, ty, p, p), p * 6, p * 6)).toString('base64');
      return sendJSON(res, 200, { ok: true, target: { x: tx, y: ty, size: p,
        confidence: record.confidence, targetMean: record.targetMean,
        pngBase64: targetPng, largeBase64: targetLarge }, candidates: candidatePngs });
    }

    // Grid of available target positions for the click-to-inspect overlay.
    if (req.method === 'GET' && route === '/api/targets') {
      if (!STATE.lastResult) throw new Error('run the reconstruction first');
      const targets = STATE.lastResult.diagnostics.matchIndexFull.map((m) => ({
        x: m.target.x, y: m.target.y, size: m.target.size, confidence: m.confidence,
      }));
      return sendJSON(res, 200, { ok: true, patchSize: STATE.lastResult.params.patchSize,
        lrWidth: STATE.input.width, lrHeight: STATE.input.height, targets });
    }

    if (req.method === 'GET' && route === '/api/params') {
      return sendJSON(res, 200, { ok: true, defaults: require('../engine').DEFAULT_PARAMS,
        current: STATE.lastParams || require('../engine').DEFAULT_PARAMS });
    }

    if (req.method === 'POST' && route === '/api/sweep') {
      if (!STATE.input) throw new Error('upload an image first');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const scale = Number(body.scale) || 2;
      const values = body.values || [];
      const key = String(body.param || 'confidenceThreshold');
      const rows = [];
      for (const value of values) {
        const overrides = {};
        overrides[key] = Number(value);
        const r = runSuperResolution(STATE.input, scale, overrides);
        let cs = 0, tc = 0;
        for (const v of r.confidenceMap) cs += v;
        for (const v of r.transferMap) if (v > 0.5) tc++;
        rows.push({ value, residualRMS: r.residualRMS,
          meanConfidence: Number((cs / r.confidenceMap.length).toFixed(4)),
          transferFraction: Number((tc / r.transferMap.length).toFixed(4)),
          srBase64: imageToDataPayload(r.sr) });
      }
      return sendJSON(res, 200, { ok: true, param: key, rows });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    // Failure feedback path: kernel errors are surfaced to the GUI.
    sendJSON(res, 400, { ok: false, error: err.message, stack: err.stack.split('\n').slice(0, 4) });
  }
});

function start(port = 8123) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`self-similarity SR GUI: http://localhost:${port}/`);
      console.log('press Ctrl+C to stop');
      resolve(server);
    });
  });
}

if (require.main === module) start(Number(process.argv[2] || 8123));
module.exports = { server, start };
