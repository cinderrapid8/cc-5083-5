'use strict';
// Scene: pseudo-text signboard.
//
// Family: pseudo-text graphics. Abstract glyph strokes (no real alphabet) in
// repeated rows. At reference resolution the glyphs have thin terminals and
// tight counters; at LR those vanish and many glyphs become nearly identical.
// Two decoy glyphs keep common coarse strokes but add a thin terminal that
// only exists at reference resolution, so copying a neighbouring glyph yields
// a sharp but objectively wrong answer.

module.exports = {
  name: 'signboard',
  family: 'pseudo-text',
  width: 300,
  height: 204,
  supersample: 3,
  background: [214, 210, 200],
  seed: 211,
  description: 'Three rows of abstract glyph strokes on a painted sign, plus rule lines and a small caption block.',
  expected: {
    highRepeat: true,
    decoys: 'two glyph cells differ by a sub-LR thin terminal',
    lowSimilarity: 'blank margin and painted rule lines carry no recoverable structure',
  },
  ops: [
    { op: 'gradient', from: [206, 203, 194], to: [178, 176, 168], axis: 'y' },
    // Sign plate and frame.
    { type: 'rect', x: 18, y: 14, w: 264, h: 148, color: [34, 46, 60], alpha: 1 },
    { type: 'rect', x: 23, y: 19, w: 254, h: 138, color: [238, 236, 226], alpha: 1 },
    // Ruled border: two isolated thin lines, one slightly thicker.
    { type: 'rect', x: 30, y: 26, w: 240, h: 1, color: [70, 74, 80], alpha: 0.9 },
    { type: 'rect', x: 30, y: 149, w: 240, h: 2, color: [70, 74, 80], alpha: 0.9 },

    // Three glyph rows; row 0 and 2 repeat the same templates more densely.
    {
      op: 'glyphBand', x: 34, y: 34, w: 232, h: 34, cols: 7, rows: 1,
      gapX: 9, stroke: 2.2, seed: 211, decoyCells: [[0, 3]],
      color: [26, 30, 38],
    },
    {
      op: 'glyphBand', x: 34, y: 74, w: 232, h: 34, cols: 6, rows: 1,
      gapX: 14, stroke: 3.0, seed: 223, decoyCells: [[0, 4]],
      color: [30, 34, 42],
    },
    {
      op: 'glyphBand', x: 34, y: 112, w: 176, h: 26, cols: 6, rows: 1,
      gapX: 10, stroke: 1.6, seed: 227, color: [48, 52, 60],
    },

    // Small isolated ticks / caption marks; no repeated macro structure.
    {
      type: 'uniqueField', x: 218, y: 106, w: 54, h: 34, cell: 17, octaves: 2,
      seed: 233, from: [206, 204, 194], to: [228, 226, 216], alpha: 0.8,
    },
    { type: 'grain', x: 218, y: 106, w: 54, h: 34, seed: 239, amplitude: 5 },
    { type: 'rect', x: 224, y: 114, w: 1, h: 18, color: [60, 64, 70], alpha: 0.9 },
    { type: 'rect', x: 234, y: 114, w: 1, h: 11, color: [60, 64, 70], alpha: 0.9 },
    { type: 'rect', x: 246, y: 114, w: 2, h: 18, color: [60, 64, 70], alpha: 0.9 },
    { type: 'rect', x: 258, y: 114, w: 1, h: 15, color: [60, 64, 70], alpha: 0.9 },

    // Mounting bolts and ground shadow.
    { type: 'circle', cx: 36, cy: 36, r: 2.2, color: [120, 124, 130], alpha: 1 },
    { type: 'circle', cx: 264, cy: 36, r: 2.2, color: [120, 124, 130], alpha: 1 },
    { type: 'rect', x: 18, y: 162, w: 264, h: 9, color: [120, 118, 112], alpha: 0.55 },
  ],
  regions: [
    { name: 'glyph-row-A', kind: 'pseudo-text', rect: [24, 24, 252, 48],
      note: 'repeated glyph forms; thin terminals lost at LR' },
    { name: 'decoy-glyph-A', kind: 'decoy', rect: [132, 24, 36, 48],
      note: 'extra terminal below LR resolution' },
    { name: 'glyph-row-B', kind: 'pseudo-text', rect: [24, 72, 252, 36],
      note: 'larger glyphs; some may transfer reliably' },
    { name: 'decoy-glyph-B', kind: 'decoy', rect: [192, 72, 36, 36],
      note: 'extra terminal below LR resolution' },
    { name: 'caption-ticks', kind: 'thin-lines', rect: [216, 108, 60, 36],
      note: 'isolated 1 px ticks on nearly blank ground' },
    { name: 'plate-margin', kind: 'untextured', rect: [24, 132, 252, 12],
      note: 'blank plate; should fall back' },
  ],
};
