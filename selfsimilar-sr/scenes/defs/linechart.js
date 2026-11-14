'use strict';
// Scene: isolated line test chart.
//
// Family: isolated thin lines. Bars and ticks of 1-2 px width, deliberately
// irregular spacing so they are *not* periodic and cannot be recovered by
// naive copy of a neighbour. Some segments are single isolated features in
// otherwise empty space: exactly where a copied texture edge would be wrong.
// Also includes hairline circles and a diagonal.

module.exports = {
  name: 'linechart',
  family: 'thin-lines',
  width: 288,
  height: 192,
  supersample: 3,
  background: [246, 245, 241],
  seed: 307,
  description: 'Calibration chart with isolated hairlines, broken rules, hairline circles and one diagonal.',
  expected: {
    highRepeat: false,
    decoys: 'one hairline segment has a gap below LR resolution',
    lowSimilarity: 'isolated features have no matching neighbours',
  },
  ops: [
    { op: 'gradient', from: [250, 249, 245], to: [236, 235, 230], axis: 'y' },

    // Dense horizontal rules with irregular spacing (thin-line family).
    {
      op: 'stripeField', x: 20, y: 20, w: 240, h: 58, direction: 'h',
      minGap: 4, maxGap: 10, thickness: 1, thickEvery: 6, breakChance: 0.45,
      seed: 307, color: [34, 38, 46],
    },
    // Vertical tick comb below it.
    {
      op: 'stripeField', x: 20, y: 88, w: 120, h: 44, direction: 'v',
      minGap: 3, maxGap: 7, thickness: 1, thickEvery: 4, breakChance: 0.2,
      seed: 311, color: [40, 44, 52],
    },

    // Isolated hairline circle (2 concentric), no repeated neighbour.
    { type: 'circle', cx: 196, cy: 108, r: 30, color: [52, 56, 64], alpha: 1 },
    { type: 'circle', cx: 196, cy: 108, r: 30 - 2.4, color: [52, 56, 64], alpha: 0.85 },
    { type: 'circle', cx: 196, cy: 108, r: 4, color: [52, 56, 64], alpha: 1 },

    // Single 1 px diagonal.
    { type: 'segment', x1: 158, y1: 142, x2: 262, y2: 76, width: 1.2,
      color: [44, 48, 56], alpha: 1, round: false },
    // Crossing shorter diagonal (still isolated, forms an X).
    { type: 'segment', x1: 160, y1: 78, x2: 258, y2: 140, width: 1.1,
      color: [44, 48, 56], alpha: 0.9, round: false },

    // Isolated short marks (decoy: the middle dash is broken below LR).
    { type: 'rect', x: 26, y: 148, w: 34, h: 2, color: [46, 50, 58], alpha: 1 },
    { type: 'rect', x: 70, y: 148, w: 34, h: 2, color: [46, 50, 58], alpha: 1 },
    // Same visual weight at LR, but a 1.2 px gap at reference resolution.
    { type: 'rect', x: 112, y: 148, w: 40, h: 2, color: [46, 50, 58], alpha: 1 },
    { type: 'rect', x: 124.4, y: 148, w: 1.2, h: 2, color: [252, 251, 248], alpha: 1 },

    // Isolated cross marks near the bottom; irregular positions.
    { type: 'segment', x1: 30, y1: 168, x2: 42, y2: 168, width: 1, color: [40, 44, 52], alpha: 1, round: false },
    { type: 'segment', x1: 36, y1: 162, x2: 36, y2: 174, width: 1, color: [40, 44, 52], alpha: 1, round: false },
    { type: 'segment', x1: 74, y1: 171, x2: 84, y2: 171, width: 1, color: [40, 44, 52], alpha: 1, round: false },
    { type: 'segment', x1: 79, y1: 165, x2: 79, y2: 177, width: 1, color: [40, 44, 52], alpha: 1, round: false },
    { type: 'segment', x1: 232, y1: 166, x2: 244, y2: 166, width: 1.2, color: [40, 44, 52], alpha: 1, round: false },
    { type: 'segment', x1: 238, y1: 160, x2: 238, y2: 172, width: 1.2, color: [40, 44, 52], alpha: 1, round: false },
  ],
  regions: [
    { name: 'rule-stack', kind: 'thin-lines', rect: [12, 12, 264, 72],
      note: 'irregular rules; a copied period would be wrong' },
    { name: 'tick-comb', kind: 'thin-lines', rect: [12, 84, 132, 48],
      note: 'vertical ticks, mixed thickness' },
    { name: 'hairline-circle', kind: 'isolated', rect: [156, 72, 72, 72],
      note: 'single unique object, no neighbour to borrow from' },
    { name: 'decoy-dash', kind: 'decoy', rect: [108, 144, 48, 12],
      note: 'middle dash has a 1.2 px break below LR resolution' },
    { name: 'diagonal-cross', kind: 'isolated', rect: [156, 72, 108, 72],
      note: '1 px diagonals; transfer often stair-steps or doubles them' },
    { name: 'blank-ground', kind: 'untextured', rect: [12, 180, 264, 12],
      note: 'empty paper; should fall back' },
  ],
};
