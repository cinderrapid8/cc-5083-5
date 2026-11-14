'use strict';
// Anomaly detection for a reconstruction.
//
// Everything below is computed from maps the reconstruction already produced
// (observation residual, confidence, transfer mask, colour channels). No
// reference image and no threshold tuned to a particular scene are involved,
// so an anomaly here means "the reconstruction itself is inconsistent", not
// "the reconstruction differs from a hidden answer".
//
// Each anomaly is a concrete region with a measured value and a short,
// human-readable cause, so the GUI can point at it instead of printing a
// generic warning.

const { resample } = require('./image');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

// Connected hot-spot regions on a boolean mask over the LR grid.
function components(mask, w, h, minPixels) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let count = 0, sum = 0, peak = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, y = (j / w) | 0;
      count++; sum += mask.sum ? mask.sum[j] : 1;
      if (mask.peak) peak = Math.max(peak, mask.peak[j]);
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
      const nb = [j - 1, j + 1, j - w, j + w];
      for (const k of nb) {
        if (k < 0 || k >= mask.length || seen[k] || !mask[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (count >= minPixels) {
      out.push({ x0, y0, x1, y1, pixels: count, peak: peak, mean: sum / count });
    }
  }
  out.sort((a, b) => b.pixels - a.pixels);
  return out;
}

function detectAnomalies(result) {
  const { confidenceLR, transferLR, residualMagnitude, sr, bicubic } = result;
  const anomalies = [];
  if (!confidenceLR || !transferLR) return anomalies;

  const lw = result.diagnostics.confidenceLRWidth
    || Math.round(sr.width / result.scale);
  const lh = result.diagnostics.confidenceLRHeight
    || Math.round(sr.height / result.scale);
  const scale = result.scale;

  // 1. Large confident-transfer area whose own observation residual is high:
  //    the reconstruction claims detail here that does not reproject back to
  //    the observed pixels. This is the strongest signal of a wrong match.
  const resSorted = Float64Array.from(residualMagnitude).sort();
  const hot = percentile(resSorted, 0.97);
  const hotMask = new Uint8Array(lw * lh);
  hotMask.peak = new Float64Array(lw * lh);
  hotMask.sum = new Float64Array(lw * lh);
  for (let i = 0; i < lw * lh; i++) {
    if (transferLR[i] > 0.5 && residualMagnitude[i] >= hot && hot > 0.5) {
      hotMask[i] = 1;
      hotMask.peak[i] = residualMagnitude[i];
      hotMask.sum[i] = residualMagnitude[i];
    }
  }
  const hotComps = components(hotMask, lw, lh, 6).slice(0, 6);
  for (const c of hotComps) {
    anomalies.push({
      kind: 'transfer-residual-conflict',
      severity: c.mean > hot * 1.4 ? 'high' : 'medium',
      lrRect: [c.x0, c.y0, c.x1 - c.x0 + 1, c.y1 - c.y0 + 1],
      hrRect: [c.x0 * scale, c.y0 * scale, (c.x1 - c.x0 + 1) * scale, (c.y1 - c.y0 + 1) * scale],
      measured: { meanResidual: Number(c.mean.toFixed(3)), peakResidual: Number(c.peak.toFixed(3)) },
      message: 'Detail was transferred here, but the result does not reproject to the '
        + 'observed input: the matched example is probably not the right one.',
    });
  }

  // 2. Chromatic drift beyond the conservative chroma baseline. Transfer and
  //    back-projection are luminance-only, so the SR and bicubic images share
  //    the exact same chroma upscale. Comparing their chrominance isolates
  //    any real colour movement from the harmless RGB<->YCbCr round-trip
  //    error that both images undergo identically.
  if (bicubic) {
    const w = sr.width, h = sr.height;
    const yccSR = require('./image').rgbToYCbCr(sr);
    const yccBi = require('./image').rgbToYCbCr(bicubic);
    let bad = 0, peak = 0;
    for (let i = 0; i < w * h; i++) {
      const d = Math.hypot(yccSR.planes[1][i] - yccBi.planes[1][i],
        yccSR.planes[2][i] - yccBi.planes[2][i]);
      if (d > 2.0) { bad++; peak = Math.max(peak, d); }
    }
    if (bad > 20) {
      const frac = bad / (w * h);
      anomalies.push({
        kind: 'chroma-artifact',
        severity: (peak > 4 && frac > 0.002) ? 'high' : frac > 0.002 ? 'medium' : 'low',
        measured: {
          pixels: bad,
          fraction: Number(frac.toFixed(5)),
          peakChromaDelta: Number(peak.toFixed(3)),
        },
        message: 'Output chroma differs from the conservative bicubic baseline on '
          + `${bad} pixels (peak ${peak.toFixed(1)}, ${(frac * 100).toFixed(2)}% of the frame). `
          + 'Transfer is luminance-only, so the drift comes from luminance pushing '
          + 'RGB out of gamut and being clipped, which shifts colour locally.',
      });
    }
  }

  // 3. Low-confidence share. If most of the frame falls below the threshold,
  //    the scene simply does not contain enough reusable structure and the
  //    honest answer is "fallback", not "detail".
  let gated = 0;
  for (let i = 0; i < confidenceLR.length; i++) {
    if (confidenceLR[i] < result.params.confidenceThreshold) gated++;
  }
  const gatedFrac = gated / confidenceLR.length;
  if (gatedFrac > 0.5) {
    anomalies.push({
      kind: 'low-similarity-fallback',
      severity: gatedFrac > 0.8 ? 'high' : 'medium',
      measured: { gatedFraction: Number(gatedFrac.toFixed(3)), threshold: result.params.confidenceThreshold },
      message: `${(gatedFrac * 100).toFixed(1)}% of patches fall below the confidence `
        + 'threshold and use conservative resampling. The input offers little reusable detail here.',
    });
  }

  // 4. Edge doubling: the SR gradient energy is much higher than bicubic's in
  //    a region where transfer happened. Copying a thin line or glyph stroke
  //    from another location often produces a second, nearby edge.
  const gradEnergy = (img) => {
    const w = img.width;
    const g = new Float64Array(w * img.height);
    for (let y = 0; y + 1 < img.height; y++) {
      for (let x = 0; x + 1 < w; x++) {
        const i = y * w + x;
        g[i] = Math.hypot(img.planes[0][i + 1] - img.planes[0][i],
          img.planes[0][i + w] - img.planes[0][i]);
      }
    }
    return g;
  };
  const gs = gradEnergy(sr), gb = gradEnergy(bicubic);
  let doubled = 0;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i] > gb[i] * 1.8 + 4) doubled++;
  }
  if (doubled > sr.width * sr.height * 0.004) {
    anomalies.push({
      kind: 'edge-energy-excess',
      severity: doubled > sr.width * sr.height * 0.02 ? 'high' : 'medium',
      measured: { pixels: doubled, fraction: Number((doubled / gs.length).toFixed(4)) },
      message: 'Gradient energy well above the bicubic baseline over a contiguous area. '
        + 'This is the signature of duplicated thin lines or double edges, not of new detail.',
    });
  }

  // Sort by severity then measured size, so the UI can show the worst first.
  const rank = { high: 0, medium: 1, low: 2 };
  anomalies.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return anomalies;
}

module.exports = { detectAnomalies, components, percentile };
