'use strict';
// Scene: repeated modern facade.
//
// Family: repeated architectural texture. The reference resolution shows rows
// of near-identical window panels; the low-resolution input no longer resolves
// mullions, sills or the diagonal glazing highlight. A few "decoy" cells carry
// a sub-LR-pixel detail change (mirrored highlight / shifted mullion / thin
// extra bar). Their coarse appearance still matches neighbouring panels, which
// is precisely where self-similar transfer copies the wrong micro-texture.
//
// Regions are declared in reference-pixel coordinates and are used by the
// evaluation to report local residuals instead of only whole-image averages.

module.exports = {
  name: 'facade',
  family: 'repeated-architecture',
  width: 288,
  height: 192,
  supersample: 3,
  background: [198, 206, 214],
  seed: 101,
  description: 'Window grid with repeated panels, sills, balcony railings and a plain stucco patch.',
  expected: {
    highRepeat: true,
    decoys: 'two window cells differ only below the LR sampling limit',
    lowSimilarity: 'stucco patch and sky band have no exact repeats',
  },
  ops: [
    { op: 'gradient', from: [176, 194, 210], to: [222, 226, 230], axis: 'y' },

    // Main window band: 5 columns x 2 rows of repeated panels.
    {
      op: 'panelGrid', x: 14, y: 16, w: 260, h: 108, cols: 5, rows: 2,
      gapX: 9, gapY: 10, frameThickness: 4, seed: 101,
      decoyCells: [[0, 2], [1, 4]],
    },

    // Balcony rail: thin vertical posts and two horizontal rails. The posts
    // are isolated 1 px lines at reference resolution.
    {
      op: 'stripeField', x: 14, y: 130, w: 260, h: 26, direction: 'v',
      minGap: 5, maxGap: 10, thickness: 1, breakChance: 0.15, seed: 113,
      color: [58, 62, 68],
    },
    { type: 'rect', x: 14, y: 131, w: 260, h: 2, color: [44, 48, 54], alpha: 0.92 },
    { type: 'rect', x: 14, y: 153, w: 260, h: 2, color: [44, 48, 54], alpha: 0.92 },
    { type: 'rect', x: 14, y: 156, w: 260, h: 22, color: [120, 116, 110], alpha: 0.9 },
    { type: 'rect', x: 14, y: 156, w: 260, h: 2, color: [74, 70, 66], alpha: 0.9 },

    // Plain stucco patch: band-limited unique field, no repeated structure.
    { type: 'grain', x: 16, y: 160, w: 120, h: 30, seed: 121, amplitude: 9 },
    {
      type: 'uniqueField', x: 16, y: 160, w: 120, h: 30, cell: 26, octaves: 2,
      seed: 127, from: [118, 114, 108], to: [152, 146, 138], alpha: 0.85,
    },
    // A fixed downpipe: a single isolated vertical line crossing flat wall.
    { type: 'rect', x: 214, y: 158, w: 3, h: 30, color: [70, 74, 78], alpha: 0.95 },
    { type: 'rect', x: 213, y: 158, w: 5, h: 2, color: [48, 52, 56], alpha: 0.9 },

    // Sky: smooth gradient only, so nothing can be borrowed there.
    { type: 'grain', x: 0, y: 0, w: 288, h: 14, seed: 131, amplitude: 3 },
  ],
  regions: [
    { name: 'window-band', kind: 'repeated', rect: [12, 12, 264, 120],
      note: 'strong panel repetition; expectation is a clear gain' },
    { name: 'decoy-cell-A', kind: 'decoy', rect: [120, 12, 48, 60],
      note: 'highlight mirrored and mullion shifted below LR resolution' },
    { name: 'decoy-cell-B', kind: 'decoy', rect: [228, 72, 48, 60],
      note: 'extra thin bar exists only at reference resolution' },
    { name: 'balcony-rail', kind: 'thin-lines', rect: [12, 132, 264, 24],
      note: 'isolated posts; transfer may double thin lines' },
    { name: 'stucco', kind: 'random', rect: [12, 156, 132, 36],
      note: 'band-limited noise, no exact repeats' },
    { name: 'sky', kind: 'untextured', rect: [0, 0, 288, 12],
      note: 'smooth gradient; should fall back everywhere' },
  ],
};
