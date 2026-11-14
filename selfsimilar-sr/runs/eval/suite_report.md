# Self-similarity asset suite — objective report

Parameters: {"patchStride":6,"shortlist":10,"backProjectionIters":3,"pyramidLevels":3}

| scene | scale | PSNR SR | PSNR bicubic | gain dB | gradErr gain | resid RMS | wrong-transfer blocks | regions worse |
|---|---|---|---|---|---|---|---|---|
| facade | 2x | 22.97 | 21.58 | +1.39 | -0.04 | 0.817 | 6 | — |
| facade | 3x | 20.61 | 20.03 | +0.58 | -0.74 | 0.677 | 2 | sky |
| facade | 4x | 19.03 | 18.85 | +0.18 | -0.65 | 1.131 | 2 | stucco, sky |
| linechart | 2x | 23.30 | 21.37 | +1.93 | 0.74 | 1.373 | 5 | blank-ground |
| linechart | 3x | 20.55 | 20.10 | +0.45 | -0.96 | 0.855 | 13 | blank-ground |
| linechart | 4x | 19.02 | 18.86 | +0.16 | -0.63 | 1.138 | 2 | blank-ground |
| masonry | 2x | 28.40 | 26.85 | +1.55 | -0.77 | 1.754 | 30 | — |
| masonry | 3x | 26.02 | 25.23 | +0.78 | -0.71 | 1.524 | 0 | — |
| masonry | 4x | 23.03 | 23.13 | -0.10 | -1.18 | 1.233 | 38 | brick-courses, decoy-brick-2, sky-strip |
| randomfield | 2x | 24.75 | 24.20 | +0.55 | 3.42 | 0.533 | 0 | — |
| randomfield | 3x | 23.95 | 23.80 | +0.15 | 1.49 | 0.232 | 0 | — |
| randomfield | 4x | 23.56 | 23.51 | +0.05 | 0.78 | 0.501 | 1 | — |
| signboard | 2x | 22.49 | 20.79 | +1.70 | -0.17 | 1.138 | 13 | — |
| signboard | 3x | 20.02 | 19.18 | +0.84 | -0.81 | 0.903 | 4 | — |
| signboard | 4x | 18.06 | 17.98 | +0.08 | -1.81 | 1.772 | 3 | — |

Negative gains and wrong-transfer blocks are reported, not filtered. A small or negative gain on the decoy/low-similarity regions is the expected honest outcome.