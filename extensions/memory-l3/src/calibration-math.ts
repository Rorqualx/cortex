/**
 * Shared calibration math for cross-embedding-model threshold mapping.
 *
 * Single source of truth for `linearRegression`, imported by the calibration
 * tool (`scripts/calibrate-embeddings.ts`) and its tests so the two cannot
 * drift — they previously carried hand-copied versions that had already
 * diverged (the test copy dropped the tool's dead `sumY2`).
 */

/** Ordinary least-squares fit of `ys ~ slope*xs + intercept`, with R². */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n === 0 || ys.length !== n) return { slope: 1, intercept: 0, r2: 0 };

  // One bounded pass over the paired samples keeps xs[i]/ys[i] provably in
  // range (noUncheckedIndexedAccess).
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) continue;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denom = n * sumX2 - sumX * sumX;
  const slope = denom === 0 ? 1 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R²
  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) continue;
    ssTot += (y - meanY) ** 2;
    ssRes += (y - (slope * x + intercept)) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}
