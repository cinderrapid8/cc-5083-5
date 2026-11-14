'use strict';
// Scene interpreter: turns an editable scene spec (scenes/defs/*.js) into
// concrete draw operations, then rasterises it into a reference Image.
//
// The scene spec is the single source of truth. The same resolved op list is
// used to (a) render the PNG reference and (b) export an SVG / JSON scene so
// the asset stays editable. Procedural ops (panel grids, glyph bands, stripe
// fields) expand into explicit primitives, so editing the generated SVG does
// not require re-running the generator.

const path = require('path');
const { Canvas } = require('./canvas');
const { expandProcedural } = require('./procedural');

function resolveOps(scene) {
  const ops = [];
  const push = (op) => {
    const expanded = expandProcedural(op);
    if (expanded) { for (const e of expanded) ops.push(e); return; }
    if (!op.type) throw new Error(`draw op has no type: ${JSON.stringify(op).slice(0, 120)}`);
    ops.push(op);
  };
  const walk = (op) => {
    if (op.op === 'gradient') return; // drawn first by renderScene
    if (op.op === 'group') {
      for (const child of op.ops) walk(child);
      return;
    }
    if (op.op === 'repeat') {
      // Grid repetition of a sub-op list with per-instance offset/jitter.
      const { rows, cols, dx, dy, jitter = 0, seed = 1 } = op;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ox = c * dx, oy = r * dy;
          const saved = [];
          for (const child of op.ops) {
            const sub = JSON.parse(JSON.stringify(child));
            offsetOp(sub, ox, oy);
            if (jitter && sub.type === 'rect') {
              const h = (Math.imul(r * 73856093 ^ c * 19349663 ^ seed, 2654435761) >>> 0) & 255;
              sub.x += (h / 255 - 0.5) * 2 * jitter;
            }
            saved.push(sub);
          }
          for (const s of saved) walk(s);
        }
      }
      return;
    }
    push(op);
  };
  for (const op of scene.ops) walk(op);
  return ops;
}

function offsetOp(op, dx, dy) {
  if (op.points) {
    op.points = op.points.map(([x, y]) => [x + dx, y + dy]);
  }
  if (op.x != null) op.x += dx;
  if (op.y != null) op.y += dy;
  if (op.cx != null) op.cx += dx;
  if (op.cy != null) op.cy += dy;
  if (op.x1 != null) op.x1 += dx;
  if (op.y1 != null) op.y1 += dy;
  if (op.x2 != null) op.x2 += dx;
  if (op.y2 != null) op.y2 += dy;
  return op;
}

function drawOps(canvas, ops) {
  for (const op of ops) {
    switch (op.type) {
      case 'rect':
        canvas.rect(op.x, op.y, op.w, op.h, op.color, op.alpha);
        break;
      case 'segment':
        canvas.segment(op.x1, op.y1, op.x2, op.y2, op.width, op.color, op.alpha, op.round !== false);
        break;
      case 'polyline':
        canvas.polyline(op.points, op.width, op.color, op.alpha);
        break;
      case 'circle':
        canvas.circle(op.cx, op.cy, op.r, op.color, op.alpha);
        break;
      case 'polygon':
        canvas.polygon(op.points, op.color, op.alpha);
        break;
      case 'gradient':
        canvas.gradient(op.from, op.to, op.axis || 'd');
        break;
      case 'texture':
        canvas.texture(op.x, op.y, op.w, op.h, op.pattern, op);
        break;
      case 'uniqueField':
        canvas.uniqueField(op.x, op.y, op.w, op.h, op);
        break;
      case 'grain':
        canvas.grain(op.x, op.y, op.w, op.h, op);
        break;
      case 'procedural': {
        const shapes = expandProcedural(op);
        if (shapes) drawOps(canvas, shapes);
        break;
      }
      default:
        throw new Error(`unknown draw op type: ${op.type}`);
    }
  }
}

function renderScene(scene) {
  const ss = scene.supersample || 3;
  const canvas = new Canvas(scene.width, scene.height, ss, scene.background);
  for (const op of scene.ops) {
    if (op.op === 'gradient') {
      canvas.gradient(op.from, op.to, op.axis || 'd');
    }
  }
  const ops = resolveOps(scene);
  drawOps(canvas, ops);
  return { image: canvas.finish(), ops };
}

function loadScene(name) {
  const file = path.join(__dirname, '..', 'defs', `${name}.js`);
  const scene = require(file);
  if (!scene || !scene.ops || !scene.width || !scene.height) {
    throw new Error(`scene ${name} is missing width/height/ops`);
  }
  return scene;
}

function listScenes() {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'defs');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
    .map((f) => f.slice(0, -3));
}

module.exports = { resolveOps, drawOps, renderScene, loadScene, listScenes };
