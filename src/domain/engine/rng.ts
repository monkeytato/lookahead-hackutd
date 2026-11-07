/**
 * Seeded PRNG (mulberry32). Every Monte Carlo draw in the engine goes through this so a replay
 * with the same seed produces identical numbers.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse-CDF sample of a triangular distribution {min, mode, max}. */
export function sampleTriangular(rand: () => number, min: number, mode: number, max: number): number {
  if (max <= min) return min;
  const u = rand();
  const c = (mode - min) / (max - min);
  return u < c
    ? min + Math.sqrt(u * (max - min) * (mode - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}
