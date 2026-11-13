'use strict';
// Self-similarity patch matching.
//
// Candidates are drawn ONLY from the input image and its downscaled
// pyramid levels (cross-scale self-similarity). A separate HR "ground
// truth" image never enters this module.
//
// Every candidate carries explicit, inspectable costs:
//   ssd      - patch appearance difference after mean removal
//   bright   - mean luminance difference between target and candidate
//   rotPen   - penalty for non-identity rotation
//   scalePen - penalty for the scale level the candidate came from
// Unreliable matches are flagged via confidence so the reconstructor can
// fall back to conservative bicubic resampling instead of hallucinating.

function makeIntegralImages(plane, w, h) {
  // ii: sum, ii2: sum of squares
  const ii = new Float64Array((w + 1) * (h + 1));
  const ii2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0, rowSum2 = 0;
    for (let x = 1; x <= w; x++) {
      const v = plane[(y - 1) * w + (x - 1)];
      rowSum += v;
      rowSum2 += v * v;
      const idx = y * (w + 1) + x;
      ii[idx] = ii[idx - (w + 1)] + rowSum;
      ii2[idx] = ii2[idx - (w + 1)] + rowSum2;
    }
  }
  return { ii, ii2, w, h };
}

// Rotated views of a source plane. For rotations 90/180/270 we build an
// explicit rotated buffer plus coordinate maps back to source pixels.
function buildRotations(plane, w, h) {
  const variants = [];
  // rotation 0
  variants.push({ rot: 0, plane, w, h,
    map: (x, y) => ({ x, y }) });
  // rotation 90 clockwise: dst(x,y) = src(w-1-y, x), dst size h x w
  {
    const rw = h, rh = w;
    const buf = new Float64Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const sx = w - 1 - y, sy = x;
        buf[y * rw + x] = plane[sy * w + sx];
      }
    }
    variants.push({ rot: 90, plane: buf, w: rw, h: rh,
      map: (x, y) => ({ x: w - 1 - y, y: x }) });
  }
  // rotation 180
  {
    const buf = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        buf[y * w + x] = plane[(h - 1 - y) * w + (w - 1 - x)];
      }
    }
    variants.push({ rot: 180, plane: buf, w, h,
      map: (x, y) => ({ x: w - 1 - x, y: h - 1 - y }) });
  }
  // rotation 270 clockwise: dst(x,y) = src(y, h-1-x), dst size h x w
  {
    const rw = h, rh = w;
    const buf = new Float64Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const sx = y, sy = h - 1 - x;
        buf[y * rw + x] = plane[sy * w + sx];
      }
    }
    variants.push({ rot: 270, plane: buf, w: rw, h: rh,
      map: (x, y) => ({ x: y, y: h - 1 - x }) });
  }
  return variants;
}

class CandidateSource {
  // level: pyramid level (0 = original input). plane: luminance of that
  // level. scaleIndex: 0 for same-scale level, increasing for smaller.
  constructor(level, plane, w, h, scaleFactor, params) {
    this.level = level;
    this.w = w; this.h = h;
    this.scaleFactor = scaleFactor;
    this.params = params;
    this.rotations = buildRotations(plane, w, h).map((v) => {
      const n = v.w * v.h;
      const mean = v.plane.reduce((a, b) => a + b, 0) / n;
      const centered = new Float64Array(n);
      for (let i = 0; i < n; i++) centered[i] = v.plane[i] - mean;
      const ints = makeIntegralImages(centered, v.w, v.h);
      return { ...v, mean, ints };
    });
  }

  // SSD of centered target patch against centered candidate patch at (cx,cy)
  // using integral images: sum t^2 + sum c^2 - 2 sum t*c.
  // The cross term is computed directly (only used on short lists).
  coarseSSD(targetCentered, p, cx, cy, rot) {
    const { ii, ii2, w } = rot.ints;
    const x1 = cx, y1 = cy, x2 = cx + p, y2 = cy + p;
    const area = p * p;
    const sumC = ii[y2 * (w + 1) + x2] - ii[y1 * (w + 1) + x2]
               - ii[y2 * (w + 1) + x1] + ii[y1 * (w + 1) + x1];
    const sumC2 = ii2[y2 * (w + 1) + x2] - ii2[y1 * (w + 1) + x2]
                - ii2[y2 * (w + 1) + x1] + ii2[y1 * (w + 1) + x1];
    // Centered candidate: subtract its own local mean to mirror target.
    const localMean = sumC / area;
    const centeredC2 = sumC2 - area * localMean * localMean;
    return centeredC2; // target energy term added later (constant per target)
  }
}

class Matcher {
  constructor(params) {
    this.params = params;
    this.sources = [];
  }

  addPyramidLevel(level, yPlane, w, h, scaleFactor) {
    this.sources.push(new CandidateSource(level, yPlane, w, h, scaleFactor, this.params));
  }

  // target: Float64Array p*p luminance patch (already extracted at LR grid).
  // exclude: { level, x, y, size, radius } — positions on the given level
  // whose source footprint overlaps the target's own footprint are skipped,
  // so a patch cannot match itself. Cross-scale levels are unaffected.
  // Returns ranked candidate records with full cost breakdown.
  matchPatch(target, p, exclude = null) {
    const params = this.params;
    const area = p * p;
    let tMean = 0;
    for (let i = 0; i < area; i++) tMean += target[i];
    tMean /= area;
    const tCentered = new Float64Array(area);
    let tEnergy = 0;
    for (let i = 0; i < area; i++) {
      tCentered[i] = target[i] - tMean;
      tEnergy += tCentered[i] * tCentered[i];
    }
    const results = [];
    const shortlistCap = params.shortlist;
    for (const src of this.sources) {
      for (const rot of src.rotations) {
        if (rot.w < p || rot.h < p) continue;
        const excludesSelf = exclude
          && src.level === exclude.level && rot.rot === 0;
        // Coarse stage: energy of centered candidate over every position.
        const shortlist = [];
        for (let cy = 0; cy <= rot.h - p; cy++) {
          for (let cx = 0; cx <= rot.w - p; cx++) {
            if (excludesSelf
              && Math.abs(cx - exclude.x) < exclude.radius
              && Math.abs(cy - exclude.y) < exclude.radius) {
              continue;
            }
            const cEnergy = src.coarseSSD(tCentered, p, cx, cy, rot);
            // Lower bound on centered SSD (cross term >= -2 sqrt(Ec Et)).
            const lb = tEnergy + cEnergy - 2 * Math.sqrt(Math.max(0, cEnergy * tEnergy));
            if (shortlist.length < shortlistCap || lb < shortlist[shortlist.length - 1].lb) {
              const rec = { cx, cy, lb, rot: rot.rot, rotObj: rot, src };
              shortlist.push(rec);
              shortlist.sort((a, b) => a.lb - b.lb);
              if (shortlist.length > shortlistCap) shortlist.pop();
            }
          }
        }
        // Fine stage: exact SSD + brightness difference on the shortlist.
        for (const cand of shortlist) {
          const { cx, cy, rotObj, src: s2 } = cand;
          let cSum = 0;
          for (let yy = 0; yy < p; yy++) {
            for (let xx = 0; xx < p; xx++) {
              cSum += rotObj.plane[(cy + yy) * rotObj.w + (cx + xx)];
            }
          }
          const cMean = cSum / area;
          let ssd = 0;
          for (let yy = 0; yy < p; yy++) {
            for (let xx = 0; xx < p; xx++) {
              const cv = rotObj.plane[(cy + yy) * rotObj.w + (cx + xx)];
              const d = tCentered[yy * p + xx] - (cv - cMean);
              ssd += d * d;
            }
          }
          const bright = Math.abs(tMean - cMean);
          const rotPen = params.rotationPenalty[rotObj.rot] || 0;
          // Scale penalty: prefer same-scale/near scales; grows for deeper
          // (smaller, blurrier) pyramid levels.
          const scalePenalty = params.scalePenalty * (s2.scaleFactor - 1);
          const normSSD = ssd / area;
          const cost = normSSD
            + params.brightnessWeight * bright
            + rotPen
            + scalePenalty;
          // Source-coordinate top-left of the p x p candidate patch.
          const corners = [
            rotObj.map(cx, cy),
            rotObj.map(cx + p - 1, cy),
            rotObj.map(cx, cy + p - 1),
            rotObj.map(cx + p - 1, cy + p - 1),
          ];
          let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
          for (const pt of corners) {
            sx0 = Math.min(sx0, pt.x); sy0 = Math.min(sy0, pt.y);
            sx1 = Math.max(sx1, pt.x); sy1 = Math.max(sy1, pt.y);
          }
          results.push({
            level: s2.level,
            scaleFactor: s2.scaleFactor,
            rotation: rotObj.rot,
            x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1,
            cx, cy,
            ssdPerPx: normSSD,
            brightnessDelta: tMean - cMean,
            rotationPenalty: rotPen,
            scalePenalty,
            cost,
          });
        }
      }
    }
    results.sort((a, b) => a.cost - b.cost || a.x - b.x || a.y - b.y || a.rotation - b.rotation);
    // Remove duplicate footprints (same level, rotation and source box) so the
    // exported candidate list shows distinct correspondences only.
    const seen = new Set();
    const unique = [];
    for (const r of results) {
      const key = `${r.level}|${r.rotation}|${r.x}|${r.y}|${r.w}|${r.h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    for (let i = 0; i < unique.length; i++) unique[i].rank = i;
    return { targetMean: tMean, targetEnergy: tEnergy, candidates: unique };
  }
}

// Confidence in [0,1] from the best/second-best cost margin and absolute
// residual level. Flat patches (low energy) are inherently ambiguous and
// get reduced confidence.
function scoreConfidence(match, params) {
  const cands = match.candidates;
  if (cands.length === 0) return 0;
  const best = cands[0];
  const second = cands.length > 1 ? cands[1] : best;
  const margin = best.cost === 0 && second.cost === 0
    ? 0 : (second.cost - best.cost) / (second.cost + 1e-9);
  // Residual fit quality: ssd per pixel on a 0..255 scale.
  const fit = Math.exp(-best.ssdPerPx / params.residualScale);
  // Structured content: near-flat targets cannot justify detail transfer.
  const structure = match.targetEnergy / (match.targetEnergy + params.flatEnergy);
  let conf = params.wMargin * margin + params.wFit * fit + params.wStructure * structure;
  if (conf < 0) conf = 0; else if (conf > 1) conf = 1;
  return conf;
}

module.exports = { Matcher, scoreConfidence, buildRotations, makeIntegralImages };
