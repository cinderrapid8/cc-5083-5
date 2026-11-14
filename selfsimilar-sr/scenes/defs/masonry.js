'use strict';
// Scene: masonry wall.
//
// Family: repeated architecture (second variant) with a different repetition
// scale and different order statistics. Brick courses are stacked in offset
// rows, mortar joints are 1 px lines, and a few bricks are decoys whose mortar
// wobble differs below the LR sampling limit. A rain-washed blank patch on the
// right has no reusable structure and must fall back.

module.exports = {
  name: 'masonry',
  family: 'repeated-architecture',
  width: 264,
  height: 192,
  supersample: 3,
  background: [168, 160, 150],
  seed: 501,
  description: 'Offset brick courses with mortar lines, a few sub-LR decoy bricks and a washed blank patch.',
  expected: {
    highRepeat: true,
    decoys: 'three bricks have mortar wobble only visible at reference resolution',
    lowSimilarity: 'washed patch and sky strip have no reusable detail',
  },
  ops: [
    { op: 'gradient', from: [186, 178, 168], to: [160, 152, 142], axis: 'y' },

    // Brick courses: 6 rows, offset alternate rows by half a brick.
    ...Array.from({ length: 6 }, (_, row) => {
      const courseY = 14 + row * 24;
      const bricks = 8;
      const bw = 29, bh = 20;
      const offset = (row % 2) ? -bw / 2 : 0;
      const shapes = [];
      for (let b = -1; b < bricks; b++) {
        const x = 8 + b * (bw + 2) + offset;
        // Decoy bricks at row 1 / col 3 and row 3 / col 5 and row 4 / col 1.
        const decoy = (row === 1 && b === 3) || (row === 3 && b === 5) || (row === 4 && b === 1);
        const h = (((Math.imul(row + 3, 73856093) ^ Math.imul(b + 7, 19349663)) >>> 0) % 1000) / 1000;
        const baseR = 132 + h * 46, baseG = 62 + h * 26, baseB = 50 + h * 20;
        shapes.push({
          type: 'rect', x, y: courseY, w: bw, h: bh,
          color: [baseR, baseG, baseB], alpha: 1,
        });
        // Specular mortar highlight along the top and left edge of the brick
        // (1 px at reference; fractions of an LR pixel).
        shapes.push({ type: 'rect', x, y: courseY, w: bw, h: 1.1, color: [206, 198, 186], alpha: 0.75 });
        shapes.push({ type: 'rect', x, y: courseY, w: 1.1, h: bh, color: [206, 198, 186], alpha: 0.55 });
        if (!decoy) {
          // Uniform interior mottling (all bricks share this pattern).
          shapes.push({
            type: 'segment', x1: x + 4, y1: courseY + bh - 4,
            x2: x + bw - 4, y2: courseY + 4, width: 1.2,
            color: [baseR - 18, baseG - 12, baseB - 8], alpha: 0.35, round: false,
          });
        } else {
          // Decoy: mottling runs the other diagonal plus a hairline notch.
          shapes.push({
            type: 'segment', x1: x + 4, y1: courseY + 4,
            x2: x + bw - 4, y2: courseY + bh - 4, width: 1.2,
            color: [baseR - 18, baseG - 12, baseB - 8], alpha: 0.35, round: false,
          });
          shapes.push({
            type: 'rect', x: x + bw * 0.62, y: courseY + bh - 3.5,
            w: 1, h: 2.6, color: [40, 34, 30], alpha: 0.8,
          });
        }
      }
      return shapes;
    }).flat(),

    // Mortar joints: two horizontal bands.
    { type: 'rect', x: 0, y: 158, w: 264, h: 24, color: [148, 142, 134], alpha: 0.85 },
    { type: 'rect', x: 0, y: 158, w: 264, h: 1.5, color: [96, 92, 88], alpha: 0.8 },

    // Washed blank patch: unique band-limited field with grain, no repeats.
    {
      type: 'uniqueField', x: 176, y: 160, w: 82, h: 21, cell: 21, octaves: 2,
      seed: 511, from: [128, 122, 116], to: [172, 166, 158], alpha: 0.9,
    },
    { type: 'grain', x: 176, y: 160, w: 82, h: 21, seed: 521, amplitude: 11 },

    // Sky strip above; gradient only.
    { type: 'rect', x: 0, y: 0, w: 264, h: 12, color: [196, 204, 212], alpha: 0.75 },
    { type: 'grain', x: 0, y: 0, w: 264, h: 12, seed: 523, amplitude: 4 },
  ],
  regions: [
    { name: 'brick-courses', kind: 'repeated', rect: [0, 12, 264, 144],
      note: 'offset courses; strong coarse repetition but many near-duplicates' },
    { name: 'decoy-brick-1', kind: 'decoy', rect: [84, 36, 36, 24],
      note: 'mottling diagonal reversed and a hairline notch, both below LR resolution' },
    { name: 'decoy-brick-2', kind: 'decoy', rect: [144, 84, 36, 24],
      note: 'second decoy: reversed mottling plus sub-LR notch' },
    { name: 'decoy-brick-3', kind: 'decoy', rect: [36, 108, 36, 24],
      note: 'third decoy: same coarse brick, different micro-texture' },
    { name: 'mortar-band', kind: 'thin-lines', rect: [0, 156, 264, 36],
      note: '1.5 px joint line on low-contrast boundary' },
    { name: 'washed-patch', kind: 'random', rect: [168, 156, 96, 36],
      note: 'band-limited washed area; nothing exact to borrow' },
    { name: 'sky-strip', kind: 'untextured', rect: [0, 0, 264, 12],
      note: 'smooth sky; should fall back' },
  ],
};
