'use strict';
// Deterministic PRNG helpers for procedural scenes. No Math.random() is
// used anywhere in the asset pipeline, so rebuilding is byte-reproducible.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Coordinate-hashed value in [0,1). Used for per-pixel noise so the value
// at (x,y) does not depend on the order in which primitives are painted.
function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
        + Math.imul(seed | 0, 69069)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function pick(list, rng) {
  return list[Math.min(list.length - 1, (rng() * list.length) | 0)];
}

module.exports = { mulberry32, hash2, pick };
