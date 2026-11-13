'use strict';
// Visualisation helpers shared by the CLI, server and evaluation script.
// These only render already-computed maps; they never perform matching or
// read any reference image.

const { Image } = require('./image');

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return arr.length ? s / arr.length : 0;
}

function fraction(arr, thr) {
  let k = 0;
  for (const v of arr) if (v > thr) k++;
  return arr.length ? k / arr.length : 0;
}

// Blue (low) -> red (high) confidence heatmap.
function heatmap(arr, w, h) {
  const img = new Image(w, h, 3);
  for (let i = 0; i < arr.length; i++) {
    const t = Math.max(0, Math.min(1, arr[i]));
    img.planes[0][i] = 255 * t;
    img.planes[1][i] = 255 * (1 - Math.abs(2 * t - 1));
    img.planes[2][i] = 255 * (1 - t);
  }
  return img;
}

// Detail-transfer regions overlaid in green on a copy of the SR result.
function transferOverlay(arr, w, h, base) {
  const img = base.clone();
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > 0.5) {
      img.planes[0][i] *= 0.4;
      img.planes[1][i] = 180 + 0.3 * img.planes[1][i];
      img.planes[2][i] *= 0.4;
    }
  }
  return img;
}

module.exports = { mean, fraction, heatmap, transferOverlay };
