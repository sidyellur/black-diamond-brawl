/**
 * Seeded PRNG (design-spec §4.2): mulberry32, a small 32-bit generator —
 * one multiply-xor-shift step per call, returns a float in [0, 1). Every
 * random draw made while generating track geometry or (in later tasks)
 * placing obstacles/pickups/AI parameters must go through an instance of
 * this, so a seed fully determines the course. Runtime gameplay randomness
 * (e.g. AI bump-aggression timing) must NOT use this — it is intentionally
 * not reproducible (§4.2).
 */
export type Prng = () => number;

export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a random integer in `[min, max]` inclusive from a `Prng`. Shared by
 *  every placement pass (geometry sections, obstacles, pickups) so the
 *  seeded-draw formula lives in exactly one place. */
export function randInt(prng: Prng, min: number, max: number): number {
  return Math.floor(min + prng() * (max - min + 1));
}
