import { mulberry32, Prng } from '../track/prng';

/**
 * Runtime (non-course) randomness.
 *
 * Course generation has always been seeded — geometry, obstacle placement and
 * per-rider parameters all draw from one PRNG so a seed reproduces a course
 * exactly. Runtime randomness was deliberately excluded from that guarantee
 * (design-spec §4.2): AI bump timing and knockback direction are drawn from
 * `Math.random()` so repeated runs of the same course still differ.
 *
 * That decision stands for normal play. What it also did, though, was make
 * combat impossible to test: a fight is a chain of random rolls, so a failing
 * case could never be reproduced. This module keeps the default behaviour and
 * adds a switch.
 *
 * `setDeterministicRuntime(seed)` routes every runtime draw through a seeded
 * generator instead. Only tests and the headless combat harness call it —
 * during normal play `runtimeRandom()` is exactly `Math.random()`.
 */

let prng: Prng | null = null;

/** Switches runtime randomness to a seeded stream. Pass `null` to restore
 *  `Math.random()`. Call before constructing entities: some draws happen in
 *  field initialisers (e.g. a rider's initial bump cooldown). */
export function setDeterministicRuntime(seed: number | null): void {
  prng = seed === null ? null : mulberry32(seed);
}

/** True when runtime randomness is currently seeded. */
export function isDeterministicRuntime(): boolean {
  return prng !== null;
}

/**
 * A runtime random draw in [0, 1). Use this instead of `Math.random()` for
 * anything that affects gameplay, so the deterministic switch actually covers
 * it. Cosmetic randomness (particle jitter) may keep using `Math.random()` —
 * it cannot change an outcome.
 */
export function runtimeRandom(): number {
  return prng ? prng() : Math.random();
}
