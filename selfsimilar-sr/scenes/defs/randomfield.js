'use strict';
// Scene: field of unique random regions.
//
// Family: random regions with no borrowable detail. The reference is a
// composite of band-limited unique fields, per-pixel grain and irregular
// (non-periodic) speckle. After the documented blur+downsample almost no
// recoverable fine structure remains: a self-similar matcher should therefore
// report low confidence over these regions and fall back, rather than
// inventing detail. A few faint non-repeating curves give the matcher enough
// structure to be tempted — that is the honest failure case we want visible.

module.exports = {
  name: 'randomfield',
  family: 'random-unique',
  width: 288,
  height: 192,
  supersample: 3,
  background: [128, 130, 134],
  seed: 401,
  description: 'Patches of unique value-noise, per-pixel grain and irregular speckle; no exact repeats.',
  expected: {
    highRepeat: false,
    decoys: 'nothing to copy: the reference detail is per-pixel random',
    lowSimilarity: 'the whole frame is a region without reusable structure',
  },
  ops: [
    { op: 'gradient', from: [122, 126, 132], to: [134, 136, 138], axis: 'x' },

    // Four unique low-frequency patches (locally unique shape, not periodic).
    { type: 'uniqueField', x: 6, y: 6, w: 130, h: 72, cell: 33, octaves: 3,
      seed: 401, from: [94, 100, 108], to: [176, 180, 184], alpha: 0.9 },
    { type: 'uniqueField', x: 148, y: 6, w: 134, h: 72, cell: 41, octaves: 3,
      seed: 409, from: [150, 146, 138], to: [198, 194, 186], alpha: 0.9 },
    { type: 'uniqueField', x: 6, y: 92, w: 130, h: 78, cell: 27, octaves: 3,
      seed: 419, from: [110, 116, 122], to: [142, 148, 152], alpha: 0.9 },
    { type: 'uniqueField', x: 148, y: 92, w: 134, h: 78, cell: 37, octaves: 2,
      seed: 421, from: [86, 92, 100], to: [128, 132, 138], alpha: 0.9 },

    // Dense per-pixel grain on top. Below the LR sampling limit this is noise
    // whose exact values are unrecoverable in principle.
    { type: 'grain', x: 0, y: 0, w: 288, h: 86, seed: 431, amplitude: 26 },
    { type: 'grain', x: 0, y: 86, w: 288, h: 90, seed: 433, amplitude: 34 },

    // Irregular speckle: positions hashed from an index, not a lattice. A
    // copied speckle field would still be wrong because none repeat.
    ...Array.from({ length: 90 }, (_, k) => {
      const h1 = (((Math.imul(k + 1, 2246822519) >>> 0) % 10000) / 10000);
      const h2 = (((Math.imul(k + 7, 3266489917) >>> 0) % 10000) / 10000);
      const h3 = (((Math.imul(k + 13, 668265263) >>> 0) % 10000) / 10000);
      const x = 8 + h1 * 272, y = 8 + h2 * 160;
      const r = 0.7 + h3 * 1.5;
      const v = h3 < 0.5 ? 58 : 212;
      return { type: 'circle', cx: x, cy: y, r, color: [v, v, v], alpha: 0.75 };
    }),

    // Faint unique curves: smooth and locally unique, no periodic repeats.
    {
      type: 'polyline', width: 1.6, color: [66, 70, 78], alpha: 0.6,
      points: [
        [30, 140], [52, 122], [66, 128], [84, 108], [102, 116], [124, 96],
      ],
    },
    {
      type: 'polyline', width: 1.2, color: [210, 212, 216], alpha: 0.55,
      points: [
        [170, 40], [190, 52], [206, 44], [228, 62], [244, 54], [268, 70],
      ],
    },
  ],
  regions: [
    { name: 'unique-patch-A', kind: 'random', rect: [0, 0, 144, 84],
      note: 'band-limited unique field; no exact repeat' },
    { name: 'unique-patch-B', kind: 'random', rect: [144, 0, 144, 84],
      note: 'different seed and scale' },
    { name: 'grain-heavy', kind: 'random', rect: [0, 84, 144, 84],
      note: 'per-pixel grain dominates; detail is unsupported by the observation' },
    { name: 'speckle-field', kind: 'random', rect: [144, 84, 144, 84],
      note: 'irregular speckle plus faint unique curve' },
    { name: 'faint-curve-A', kind: 'isolated', rect: [24, 84, 108, 60],
      note: 'single thin curve on noise; transfer usually copies wrong segment' },
  ],
};
