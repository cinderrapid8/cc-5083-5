'use strict';
// Single-image self-similarity super-resolution pipeline.
//
// The only image used to find candidate detail is the input itself and its
// downscaled pyramid. A reference "clear" image is never referenced here;
// it is used only by the evaluation script.

const {
  Image, resample, degrade, rgbToYCbCr, yCbCrToRGB, clipCopy,
} = require('./image');
const { Matcher, scoreConfidence } = require('./match');

const DEFAULT_PARAMS = {
  // Patch geometry on the LR grid.
  patchSize: 5,
  patchStride: 2,
  // Multi-scale self-example pyramid.
  pyramidLevels: 3,       // includes the input level
  pyramidScale: 0.8,      // each level is 0.8x the previous
  // Candidate search.
  rotations: [0, 90, 180, 270],
  shortlist: 24,
  // Explicit cost weights.
  brightnessWeight: 0.35,
  rotationPenalty: { 0: 0, 90: 6, 180: 8, 270: 6 }, // added to per-pixel SSD cost
  scalePenalty: 3.0,      // per unit of pyramid scale difference
  // Confidence model.
  residualScale: 120,
  flatEnergy: 200,
  wMargin: 0.45,
  wFit: 0.35,
  wStructure: 0.2,
  confidenceThreshold: 0.45, // below this: conservative resampling only
  // Reconstruction.
  backProjectionIters: 8,
  bpStep: 0.8,
  // Forward degradation model used both for building the pyramid and for
  // projecting the reconstruction back to the observed scale.
  degradeSigma: 1.0,
  // How many candidates per target to keep in the exported match index.
  keepCandidates: 6,
};

function paramsWithOverrides(overrides = {}) {
  const p = { ...DEFAULT_PARAMS, ...overrides };
  p.rotationPenalty = { ...DEFAULT_PARAMS.rotationPenalty, ...(overrides.rotationPenalty || {}) };
  const intKeys = ['patchSize', 'patchStride', 'pyramidLevels', 'backProjectionIters', 'keepCandidates'];
  for (const k of intKeys) p[k] = Math.round(p[k]);
  const errors = [];
  if (p.patchSize < 3 || p.patchSize > 15 || p.patchSize % 2 === 0) {
    errors.push('patchSize must be an odd integer in [3, 15]');
  }
  if (p.patchStride < 1 || p.patchStride > 32) {
    errors.push('patchStride must be an integer in [1, 32]');
  }
  if (p.pyramidLevels < 1 || p.pyramidLevels > 5) errors.push('pyramidLevels must be in [1, 5]');
  if (p.confidenceThreshold < 0 || p.confidenceThreshold > 1) {
    errors.push('confidenceThreshold must be in [0, 1]');
  }
  if (p.brightnessWeight < 0 || p.scalePenalty < 0 || p.degradeSigma < 0) {
    errors.push('cost weights and degradeSigma must be non-negative');
  }
  if (p.backProjectionIters < 0 || p.backProjectionIters > 30) {
    errors.push('backProjectionIters must be in [0, 30]');
  }
  if (errors.length) throw new Error('invalid parameters: ' + errors.join('; '));
  return p;
}

function buildPyramid(yImage, params) {
  // Level 0 = input luminance. Deeper levels are degraded downscales of the
  // input itself, so the example bank contains only self-derived content.
  const levels = [{ img: yImage, scaleFactor: 1 }];
  let cur = yImage;
  for (let l = 1; l < params.pyramidLevels; l++) {
    const nw = Math.max(params.patchSize + 2, Math.round(cur.width * params.pyramidScale));
    const nh = Math.max(params.patchSize + 2, Math.round(cur.height * params.pyramidScale));
    const small = degrade(cur, cur.width / nw, params.degradeSigma);
    const factor = levels[l - 1].scaleFactor * (cur.width / nw);
    levels.push({ img: small, scaleFactor: factor });
    cur = small;
  }
  return levels;
}

// One 2x super-resolution step on a single-channel (luminance) image.
function superResolve2x(lrY, params, diagnostics) {
  const lw = lrY.width, lh = lrY.height;
  const hw = lw * 2, hh = lh * 2;
  const bicubic = resample(lrY, hw, hh);
  const hrBicubicPlane = bicubic.planes[0];

  // What the HR candidate region looks like when degraded to LR size:
  // HR grid is 2x LR. A p x p LR patch corresponds to a 2p x 2p HR region,
  // whose LR-degraded view is computed by the same forward model.
  const pyramid = buildPyramid(lrY, params);
  const matcher = new Matcher(params);
  pyramid.forEach((entry, li) => {
    matcher.addPyramidLevel(li, entry.img.planes[0], entry.img.width, entry.img.height, entry.scaleFactor);
  });

  const p = params.patchSize;
  const stride = params.patchStride;
  const acc = new Float64Array(hw * hh);       // accumulated HR detail estimates
  const wsum = new Float64Array(hw * hh);      // overlap weights
  const confMap = new Float64Array(lw * lh);   // confidence on LR grid
  const transferMap = new Float64Array(lw * lh);
  const matchIndex = [];

  const positions = [];
  for (let ty = 0; ty + p <= lh; ty += stride) {
    for (let tx = 0; tx + p <= lw; tx += stride) positions.push([tx, ty]);
  }
  // Cover the right/bottom borders even if the stride does not align.
  const lastX = lw - p, lastY = lh - p;
  if (lastX % stride !== 0) for (let ty = 0; ty + p <= lh; ty += stride) positions.push([lastX, ty]);
  if (lastY % stride !== 0) for (let tx = 0; tx + p <= lw; tx += stride) positions.push([tx, lastY]);
  if (lastX % stride !== 0 || lastY % stride !== 0) positions.push([lastX, lastY]);

  for (const [tx, ty] of positions) {
    const target = new Float64Array(p * p);
    for (let yy = 0; yy < p; yy++) {
      for (let xx = 0; xx < p; xx++) {
        target[yy * p + xx] = lrY.planes[0][(ty + yy) * lw + (tx + xx)];
      }
    }
    const match = matcher.matchPatch(target, p, {
      level: 0, x: tx, y: ty, size: p, radius: p + 1,
    });
    const confidence = scoreConfidence(match, params);
    const best = match.candidates[0];

    for (let yy = 0; yy < p; yy++) {
      for (let xx = 0; xx < p; xx++) {
        const gi = (ty + yy) * lw + (tx + xx);
        if (confidence > confMap[gi]) confMap[gi] = confidence;
      }
    }

    const record = {
      target: { x: tx, y: ty, size: p },
      confidence,
      targetMean: match.targetMean,
      candidates: match.candidates.slice(0, params.keepCandidates).map((c) => ({
        level: c.level,
        scaleFactor: Number(c.scaleFactor.toFixed(4)),
        rotation: c.rotation,
        x: c.x, y: c.y, w: c.w, h: c.h,
        ssdPerPx: Number(c.ssdPerPx.toFixed(4)),
        brightnessDelta: Number(c.brightnessDelta.toFixed(4)),
        rotationPenalty: c.rotationPenalty,
        scalePenalty: Number(c.scalePenalty.toFixed(4)),
        cost: Number(c.cost.toFixed(4)),
      })),
    };
    matchIndex.push(record);

    if (!best || confidence < params.confidenceThreshold) {
      // Conservative fallback: no invented detail for this target.
      continue;
    }

    // Fetch the HR example: the matched region in its source level, rotated
    // back to canonical orientation, then resampled so the LR p x p footprint
    // maps to a 2p x 2p HR patch.
    const srcLevel = pyramid[best.level].img;
    const hp = p * 2;
    const hrPatch = extractHRPatch(srcLevel, best, p, hp, params);
    if (!hrPatch) continue;

    // Degrade the HR example to LR and take only the residual high frequency;
    // adding it on top of our own bicubic base prevents copying flat content
    // or changing local luminance (anti-hallucination guard).
    const hrPatchImg = Image.fromPlanar(hp, hp, [hrPatch]);
    const lrView = degrade(hrPatchImg, 2, params.degradeSigma).planes[0]; // p x p
    const lrUp = resample(Image.fromPlanar(p, p, [lrView]), hp, hp).planes[0];

    const hx0 = tx * 2, hy0 = ty * 2;
    for (let yy = 0; yy < hp; yy++) {
      for (let xx = 0; xx < hp; xx++) {
        const detail = hrPatch[yy * hp + xx] - lrUp[yy * hp + xx];
        // Limit injected energy so a wrong match cannot create edges/text.
        const limited = Math.max(-24, Math.min(24, detail));
        const gi = (hy0 + yy) * hw + (hx0 + xx);
        // Triangular overlap window weights centre pixels more heavily.
        const wx = 1 - Math.abs(xx - (hp - 1) / 2) / hp;
        const wy = 1 - Math.abs(yy - (hp - 1) / 2) / hp;
        const w = wx * wy * confidence;
        acc[gi] += w * limited;
        wsum[gi] += w;
      }
    }
    for (let yy = 0; yy < p; yy++) {
      for (let xx = 0; xx < p; xx++) {
        transferMap[(ty + yy) * lw + (tx + xx)] = 1;
      }
    }
  }

  const srPlane = new Float64Array(hw * hh);
  for (let i = 0; i < srPlane.length; i++) {
    const detail = wsum[i] > 1e-6 ? acc[i] / wsum[i] : 0;
    srPlane[i] = hrBicubicPlane[i] + detail;
  }

  // Back-projection: enforce the known forward degradation model by pushing
  // the reconstruction through blur+downscale and correcting from the
  // observed LR residual.
  let working = srPlane;
  const bpHistory = [];
  for (let it = 0; it < params.backProjectionIters; it++) {
    const hrImg = Image.fromPlanar(hw, hh, [working]);
    const reproj = degrade(hrImg, 2, params.degradeSigma).planes[0];
    let rms = 0;
    const residualLR = new Float64Array(lw * lh);
    for (let i = 0; i < residualLR.length; i++) {
      const r = lrY.planes[0][i] - reproj[i];
      residualLR[i] = r;
      rms += r * r;
    }
    rms = Math.sqrt(rms / residualLR.length);
    bpHistory.push(Number(rms.toFixed(4)));
    if (rms < 0.05) break;
    const up = resample(Image.fromPlanar(lw, lh, [residualLR]), hw, hh).planes[0];
    const next = new Float64Array(hw * hh);
    for (let i = 0; i < next.length; i++) next[i] = working[i] + params.bpStep * up[i];
    working = next;
  }

  diagnostics.matchIndex = matchIndex;
  diagnostics.confidenceMap = confMap;
  diagnostics.transferMap = transferMap;
  diagnostics.backProjectionRMS = bpHistory;
  diagnostics.positions = positions.length;
  return Image.fromPlanar(hw, hh, [working]);
}

// Extract a 2p x 2p HR patch from a source level, undoing the recorded
// rotation and aligning it to the matched LR footprint.
function extractHRPatch(srcLevel, best, p, hp, params) {
  const sw = srcLevel.width, sh = srcLevel.height;
  const src = srcLevel.planes[0];
  // Bounding box in source coordinates recorded by the matcher.
  const x0 = best.x, y0 = best.y;
  const bw = best.w, bh = best.h;
  // Canonical (unrotated) patch buffer at source resolution.
  const canon = new Float64Array(bw * bh);
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      let sx, sy;
      switch (best.rotation) {
        case 0: sx = x0 + xx; sy = y0 + yy; break;
        case 90: sx = x0 + (bh - 1 - yy); sy = y0 + xx; break;
        case 180: sx = x0 + (bw - 1 - xx); sy = y0 + (bh - 1 - yy); break;
        case 270: sx = x0 + yy; sy = y0 + (bw - 1 - xx); break;
        default: return null;
      }
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) return null;
      canon[yy * bw + xx] = src[sy * sw + sx];
    }
  }
  // Resample the canonical source region to the fixed 2p x 2p HR grid.
  const canonImg = Image.fromPlanar(bw, bh, [canon]);
  return resample(canonImg, hp, hp).planes[0];
}

function runSuperResolution(inputRGB, scale, overrides = {}) {
  if (!(inputRGB && inputRGB.planes && inputRGB.channels >= 1)) {
    throw new Error('runSuperResolution: input must be an Image');
  }
  if (!(scale >= 1 && scale <= 4)) {
    throw new Error('scale must be in [1, 4]');
  }
  const params = paramsWithOverrides(overrides);
  const t0 = Date.now();
  const ycc = rgbToYCbCr(inputRGB);
  const yImg = Image.fromPlanar(inputRGB.width, inputRGB.height, [ycc.planes[0]]);

  // Iterative 2x steps; final step handles a remaining non-power-of-two factor.
  const steps = [];
  let cur = yImg;
  let factor = 1;
  const diagnostics = { steps: [], params };
  while (factor * 2 <= scale + 1e-9) {
    const d = {};
    cur = superResolve2x(cur, params, d);
    factor *= 2;
    steps.push({ factor, d });
    diagnostics.steps.push({
      factor,
      positions: d.positions,
      backProjectionRMS: d.backProjectionRMS,
    });
  }
  const targetW = Math.round(inputRGB.width * scale);
  const targetH = Math.round(inputRGB.height * scale);
  let srY;
  if (cur.width !== targetW || cur.height !== targetH) {
    srY = resample(cur, targetW, targetH);
  } else {
    srY = cur;
  }

  // Chrominance is always conservative bicubic: detail transfer is applied
  // only to luminance, where matching is reliable.
  const cbUp = resample(Image.fromPlanar(inputRGB.width, inputRGB.height, [ycc.planes[1]]), targetW, targetH);
  const crUp = resample(Image.fromPlanar(inputRGB.width, inputRGB.height, [ycc.planes[2]]), targetW, targetH);
  const working = [srY.planes[0], cbUp.planes[0], crUp.planes[0]];

  // Back-projection in YCbCr, channel by channel. Keeping the correction in
  // YCbCr (rather than clipping RGB each iteration) stops strong luminance
  // edges from dragging chrominance out of gamut and producing colour fringing;
  // the RGB clip happens only once at the very end.
  const observedYCC = rgbToYCbCr(inputRGB);
  const rgbBpHistory = [];
  for (let it = 0; it < params.backProjectionIters; it++) {
    const hrImg = Image.fromPlanar(targetW, targetH, working);
    const reprojRGB = degrade(yCbCrToRGB(hrImg), scale, params.degradeSigma);
    const reprojYCC = rgbToYCbCr(reprojRGB);
    const rmsPerChannel = [];
    for (let c = 0; c < 3; c++) {
      const lrResid = new Float64Array(inputRGB.width * inputRGB.height);
      let s = 0;
      for (let i = 0; i < lrResid.length; i++) {
        const r = observedYCC.planes[c][i] - reprojYCC.planes[c][i];
        lrResid[i] = r;
        s += r * r;
      }
      rmsPerChannel.push(Number(Math.sqrt(s / lrResid.length).toFixed(4)));
      const up = resample(
        Image.fromPlanar(inputRGB.width, inputRGB.height, [lrResid]),
        targetW, targetH).planes[0];
      for (let i = 0; i < up.length; i++) working[c][i] += params.bpStep * up[i];
    }
    rgbBpHistory.push(rmsPerChannel);
  }
  diagnostics.rgbBackProjectionRMS = rgbBpHistory;

  const srRGB = clipCopy(yCbCrToRGB(Image.fromPlanar(targetW, targetH, working)));
  const bicubicRGB = clipCopy(yCbCrToRGB(Image.fromPlanar(targetW, targetH, [
    resample(yImg, targetW, targetH).planes[0], cbUp.planes[0], crUp.planes[0],
  ])));

  // Observation residual: project reconstruction through the known
  // degradation model back to the input scale and compare.
  const reproj = degrade(srRGB, scale, params.degradeSigma);
  const residual = new Image(inputRGB.width, inputRGB.height, 3);
  let sumSq = 0, n = 0, maxAbs = 0;
  const perPixel = new Float64Array(inputRGB.width * inputRGB.height);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < inputRGB.width * inputRGB.height; i++) {
      const r = inputRGB.planes[c][i] - reproj.planes[c][i];
      residual.planes[c][i] = Math.abs(r);
      sumSq += r * r; n++;
      if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
      perPixel[i] += r * r;
    }
  }
  const rmse = Math.sqrt(sumSq / n);
  const residualRMS = rmse;
  // Normalised 0..255 residual magnitude map (luminance-ish, averaged).
  const residualMag = new Float64Array(inputRGB.width * inputRGB.height);
  for (let i = 0; i < perPixel.length; i++) residualMag[i] = Math.sqrt(perPixel[i] / 3);

  // Upscale the last-step confidence / transfer maps for visualisation.
  const lastD = steps.length ? steps[steps.length - 1].d : null;
  let confidenceFull = null, transferFull = null;
  if (lastD) {
    confidenceFull = resample(
      Image.fromPlanar(inputRGB.width, inputRGB.height, [lastD.confidenceMap]),
      targetW, targetH).planes[0];
    transferFull = resample(
      Image.fromPlanar(inputRGB.width, inputRGB.height, [lastD.transferMap]),
      targetW, targetH).planes[0];
  }

  diagnostics.elapsedMs = Date.now() - t0;
  diagnostics.matchIndexFull = lastD ? lastD.matchIndex : [];
  return {
    sr: srRGB,
    bicubic: bicubicRGB,
    reprojected: clipCopy(reproj),
    residual: clipCopy(residual),
    residualMagnitude: residualMag,
    residualRMS: Number(residualRMS.toFixed(4)),
    residualMax: Number(maxAbs.toFixed(4)),
    confidenceMap: confidenceFull,
    transferMap: transferFull,
    confidenceLR: lastD ? lastD.confidenceMap : null,
    transferLR: lastD ? lastD.transferMap : null,
    diagnostics,
    params,
    scale,
  };
}

module.exports = { runSuperResolution, DEFAULT_PARAMS, paramsWithOverrides };
