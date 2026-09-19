/**
 * Seeded PRNG (mulberry32).
 *
 * Benchmarks must be reproducible or they cannot be compared — Math.random()
 * would make every replay of the same tape produce a different baseline,
 * destroying the one property replay exists to provide.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default seed, overridable so you can check a result is not seed-specific. */
export const BENCHMARK_SEED = Number(process.env.BENCHMARK_SEED ?? 20260918);
