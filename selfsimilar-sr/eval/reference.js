'use strict';
// Reference-side measurements. THIS FILE IS THE ONLY PLACE IN THE EVALUATION
// THAT OPENS THE CLEAR REFERENCE IMAGE. It runs after the SR result has been
// computed and never feeds anything back into the matcher.
//
// Everything here works on rectangles expressed in REFERENCE (HR) pixels. The
// caller passes the same regions the scene declares; build-time checks already
// guarantee each region is a whole multiple of every scale, so a region maps
// to an exact block of LR pixels and to an exact block of SR output pixels.
// No nearest-neighbour rounding is used anywhere in metric matching.

const { resample } = require('../engine/image');

function regionStats(sr, bicubic, ref, rect) {
  const [x, y, w, h] = rect;
  if (x < 0 || y < 0 || x + w > ref.width || y + h > ref.height) {
    throw new Error(`region ${JSON.stringify(rect)} outside reference ${ref.width}x${ref.height}`);
  }
  if (sr.width !== ref.width || sr.height !== ref.height) {
    throw new Error(`SR grid ${sr.width}x${sr.height} != reference ${ref.width}x${ref.height}`);
  }
  let sseSR = 0, sseBi = 0, n = 0;
  let gradSR = 0, gradBi = 0, gradRef = 0, gn = 0;
  let lumaSR = 0, lumaRef = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = yy * ref.width + xx;
      for (let c = 0; c < 3; c++) {
        const rs = sr.planes[c][i];
        const rb = bicubic.planes[c][i];
        const rr = ref.planes[c][i];
        const dS = rs - rr;
        const dB = rb - rr;
        sseSR += dS * dS;
        sseBi += dB * dB;
        n++;
      }
      lumaSR += 0.299 * sr.planes[0][i] + 0.587 * sr.planes[1][i] + 0.114 * sr.planes[2][i];
      lumaRef += 0.299 * ref.planes[0][i] + 0.587 * ref.planes[1][i] + 0.114 * ref.planes[2][i];
      if (xx + 1 < x + w && yy + 1 < y + h) {
        const j = i + 1;
        const down = i + ref.width;
        const gS = Math.hypot(sr.planes[0][j] - sr.planes[0][i], sr.planes[0][down] - sr.planes[0][i]);
        const gB = Math.hypot(bicubic.planes[0][j] - bicubic.planes[0][i],
          bicubic.planes[0][down] - bicubic.planes[0][i]);
        const gR = Math.hypot(ref.planes[0][j] - ref.planes[0][i],
          ref.planes[0][down] - ref.planes[0][i]);
        gradSR += Math.abs(gS - gR);
        gradBi += Math.abs(gB - gR);
        gradRef += gR;
        gn++;
      }
    }
  }
  const psnrOf = (sse) => sse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / (sse / n));
  return {
    pixels: w * h,
    psnrSR: Number(psnrOf(sseSR).toFixed(3)),
    psnrBicubic: Number(psnrOf(sseBi).toFixed(3)),
    psnrGain: Number((psnrOf(sseSR) - psnrOf(sseBi)).toFixed(3)),
    gradientErrorSR: Number((gradSR / Math.max(1, gn)).toFixed(3)),
    gradientErrorBicubic: Number((gradBi / Math.max(1, gn)).toFixed(3)),
    gradientErrorGain: Number((gradBi / Math.max(1, gn) - gradSR / Math.max(1, gn)).toFixed(3)),
    meanLumaError: Number(((lumaSR - lumaRef) / Math.max(1, w * h)).toFixed(3)),
    // Honest "did transfer make this region worse" flag; reported for every
    // region, including the ones whose gain is small or negative.
    srWorseThanBicubic: psnrOf(sseSR) < psnrOf(sseBi) - 0.05,
  };
}

// Global (whole-frame) statistics on the exactly aligned grids.
function globalStats(sr, bicubic, ref) {
  return regionStats(sr, bicubic, ref, [0, 0, ref.width, ref.height]);
}

// Per-region pixel difference maps, as 8-bit magnitude images, so a scene
// viewer can show where the error actually sits rather than one scalar.
function regionDiffMaps(sr, bicubic, ref, rect) {
  const { Image } = require('../engine/image');
  const [x, y, w, h] = rect;
  const srMap = new Image(w, h, 1);
  const biMap = new Image(w, h, 1);
  const refCrop = new Image(w, h, 3);
  const srCrop = new Image(w, h, 3);
  const biCrop = new Image(w, h, 3);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const src = (y + yy) * ref.width + (x + xx);
      const dst = yy * w + xx;
      let ds = 0, db = 0;
      for (let c = 0; c < 3; c++) {
        refCrop.planes[c][dst] = ref.planes[c][src];
        srCrop.planes[c][dst] = sr.planes[c][src];
        biCrop.planes[c][dst] = bicubic.planes[c][src];
        const a = sr.planes[c][src] - ref.planes[c][src];
        const b = bicubic.planes[c][src] - ref.planes[c][src];
        ds += a * a; db += b * b;
      }
      srMap.planes[0][dst] = Math.min(255, Math.sqrt(ds / 3) * 4);
      biMap.planes[0][dst] = Math.min(255, Math.sqrt(db / 3) * 4);
    }
  }
  return { srDiffMap: srMap, bicubicDiffMap: biMap, refCrop, srCrop, bicubicCrop: biCrop };
}

// Generic PSNR used by the test suite; kept explicit about channel count.
function psnr(a, b) {
  let s = 0, n = 0;
  for (let c = 0; c < a.channels; c++) {
    for (let i = 0; i < a.planes[0].length; i++) {
      const d = a.planes[c][i] - b.planes[c][i];
      s += d * d; n++;
    }
  }
  if (s <= 1e-12) return Infinity;
  return 10 * Math.log10((255 * 255) / (s / n));
}

module.exports = { regionStats, globalStats, regionDiffMaps, psnr, resample };
