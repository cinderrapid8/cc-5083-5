'use strict';
// SVG / JSON export for the editable scenes.
//
// The canonical editable definition is the resolved op list (also written as
// JSON). Vector ops are exported as native SVG geometry. The raster-only fills
// (value-noise fields and per-pixel grain) are exported as opaque PNG patches
// carrying the exact rendered pixels of their rectangle, emitted in the same
// painter's order as the rasteriser. An alpha overlay would be more "layered",
// but several SVG renderers ignore image alpha and paint a black box; an opaque
// patch cropped to the op's own rectangle renders identically everywhere and is
// pixel-exact because those regions are raster by definition.

const { renderScene, drawOps } = require('./scene');

const RASTER_TYPES = new Set(['uniqueField', 'grain']);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function color(c, alpha) {
  const [r, g, b] = c.map((v) => Math.round(Math.max(0, Math.min(255, v))));
  const a = alpha == null ? 1 : alpha;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return a >= 1 ? hex : { hex, a };
}

// Filled shapes get an explicit stroke="none": some SVG rasterisers (notably
// ImageMagick's built-in one) otherwise apply a black outline even though the
// SVG spec defaults the stroke to none.
function fmt(a, b, alpha) {
  const c = color(a, alpha);
  if (typeof c === 'string') return `fill="${c}" stroke="none"`;
  return `fill="${c.hex}" fill-opacity="${c.a}" stroke="none"`;
}

function strokeFmt(c, alpha) {
  const col = color(c, alpha);
  if (typeof col === 'string') return `stroke="${col}"`;
  return `stroke="${col.hex}" stroke-opacity="${col.a}"`;
}

function svgOp(op, defs) {
  switch (op.type) {
    case 'rect':
      return `<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" ${fmt(op.color, null, op.alpha)}/>`;
    case 'segment': {
      const cap = op.round === false ? 'butt' : 'round';
      return `<line x1="${op.x1}" y1="${op.y1}" x2="${op.x2}" y2="${op.y2}" `
        + `${strokeFmt(op.color, op.alpha)} stroke-width="${op.width}" stroke-linecap="${cap}"/>`;
    }
    case 'polyline':
      return `<polyline points="${op.points.map(([x, y]) => `${x},${y}`).join(' ')}" `
        + `${strokeFmt(op.color, op.alpha)} stroke-width="${op.width}" stroke-linejoin="round"/>`;
    case 'circle':
      return `<circle cx="${op.cx}" cy="${op.cy}" r="${op.r}" ${fmt(op.color, null, op.alpha)}/>`;
    case 'polygon':
      return `<polygon points="${op.points.map(([x, y]) => `${x},${y}`).join(' ')}" ${fmt(op.color, null, op.alpha)}/>`;
    case 'texture': {
      const id = `tex${defs.length}`;
      const sp = op.spacing || 4, th = op.thickness || 1;
      const a = op.alpha == null ? 1 : op.alpha;
      let body;
      if (op.pattern === 'stripes') {
        body = `<rect x="0" y="0" width="${sp}" height="${th}" ${fmt(op.color, null, a)}/>`;
      } else if (op.pattern === 'crosshatch') {
        body = `<rect x="0" y="0" width="${sp}" height="${th}" ${fmt(op.color, null, a)}/>`
          + `<rect x="0" y="0" width="${th}" height="${sp}" ${fmt(op.color, null, a)}/>`;
      } else if (op.pattern === 'checker') {
        body = `<rect x="0" y="0" width="${sp}" height="${sp}" ${fmt(op.color, null, a)}/>`
          + `<rect x="${sp}" y="${sp}" width="${sp}" height="${sp}" ${fmt(op.color, null, a)}/>`;
      } else {
        const r = Math.max(0.75, th);
        body = `<circle cx="${sp / 2}" cy="${sp / 2}" r="${r}" ${fmt(op.color, null, a)}/>`;
      }
      const size = op.pattern === 'checker' ? sp * 2 : sp;
      const rot = op.angle ? ` patternTransform="rotate(${(op.angle * 180 / Math.PI).toFixed(2)})"` : '';
      defs.push(`<pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse"${rot}>${body}</pattern>`);
      return `<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" fill="url(#${id})"/>`;
    }
    default:
      return '';
  }
}

// Background: the scene gradient is exported as a native <linearGradient>, or,
// for diagonal gradients, as a single fully covered rect. Some minimal SVG
// rasterisers do not implement gradients, but browsers and vector editors do;
// the canonical editable definition remains assets/scenes/<name>.json.
function svgBackground(scene) {
  const grad = scene.ops.find((op) => op.op === 'gradient');
  const W = scene.width, H = scene.height;
  if (grad) return svgGradient(grad, W, H);
  const [r, g, b] = scene.background;
  return `<rect width="${W}" height="${H}" fill="rgb(${r},${g},${b})" stroke="none"/>`;
}

function svgGradient(grad, W, H) {
  const axis = grad.axis || 'd';
  const [r1, g1, b1] = grad.from.map((v) => Math.round(v));
  const [r2, g2, b2] = grad.to.map((v) => Math.round(v));
  const dir = axis === 'x' ? 'x2="1" y2="0"' : axis === 'y' ? 'x2="0" y2="1"' : 'x2="1" y2="1"';
  return `<defs><linearGradient id="bg" x1="0" y1="0" ${dir}>`
    + `<stop offset="0" stop-color="rgb(${r1},${g1},${b1})"/>`
    + `<stop offset="1" stop-color="rgb(${r2},${g2},${b2})"/></linearGradient></defs>`
    + `<rect width="${W}" height="${H}" fill="url(#bg)" stroke="none"/>`;
}

// Op rectangles are rounded outward so the patch never clips a painted pixel.
function opBounds(op, W, H) {
  const x0 = Math.max(0, Math.floor(op.x));
  const y0 = Math.max(0, Math.floor(op.y));
  const x1 = Math.min(W, Math.ceil(op.x + op.w));
  const y1 = Math.min(H, Math.ceil(op.y + op.h));
  return [x0, y0, x1 - x0, y1 - y0];
}

// Render the scene with ops[0..upto] applied, matching renderScene's order.
function renderPrefix(scene, ops, upto) {
  const { Canvas } = require('./canvas');
  const canvas = new Canvas(scene.width, scene.height, scene.supersample || 3, scene.background);
  const grad = scene.ops.find((op) => op.op === 'gradient');
  if (grad) canvas.gradient(grad.from, grad.to, grad.axis || 'd');
  drawOps(canvas, ops.slice(0, upto + 1));
  return canvas.finish();
}

function sceneToSVG(name, scene) {
  const { ops } = renderScene(scene);
  const defs = [];
  const pieces = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (RASTER_TYPES.has(op.type)) {
      const [x, y, w, h] = opBounds(op, scene.width, scene.height);
      if (w <= 0 || h <= 0) continue;
      // Crop the state *after* this raster op: later ops are then replayed
      // normally on top, so no op is applied twice. Because the patch is
      // opaque it also supersedes earlier vector ops inside its rectangle.
      const crop = renderPrefix(scene, ops, i).subImage(x, y, w, h);
      pieces.push(`  <image x="${x}" y="${y}" width="${w}" height="${h}" `
        + `href="data:image/png;base64,${encodeRGBA(crop)}"/>`);
    } else {
      const el = svgOp(op, defs);
      if (el) pieces.push('  ' + el);
    }
  }
  const body = pieces.join('\n');
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" `
    + `viewBox="0 0 ${scene.width} ${scene.height}">\n`
    + `  <!-- ${esc(name)} — generated from scenes/defs/${name}.js. Edit the JSON/spec, not this file. -->\n`;
  const dd = defs.length ? `  <defs>${defs.join('')}</defs>\n` : '';
  return head + dd + svgBackground(scene) + '\n' + body + '\n</svg>\n';
}

// Minimal RGBA PNG encoder (writePNG only emits RGB).
function encodeRGBA(img) {
  const zlib = require('zlib');
  const w = img.width, h = img.height;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const v = c < img.channels ? img.planes[c][y * w + x] : 255;
        raw[p++] = Math.round(Math.max(0, Math.min(255, v)));
      }
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function sceneToJSON(name, scene, ops) {
  return JSON.stringify({
    name,
    width: scene.width,
    height: scene.height,
    supersample: scene.supersample || 3,
    background: scene.background,
    note: 'Editable resolved scene. Regenerate with node tools/build_assets.js.',
    ops,
  }, null, 2);
}

module.exports = { sceneToSVG, sceneToJSON, encodeRGBA, RASTER_TYPES, opBounds, renderPrefix };
