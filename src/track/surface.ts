import { POWDER_SPEED_FACTOR, SEGMENT_LENGTH } from '../config';
import type { Segment, Surface } from './segment';

/**
 * Riding-surface helpers shared by the player, rivals, scoring and the HUD
 * (#39). Pure and Phaser-free: entities are handed the surface as a parameter
 * to `update()` and never hold a reference to the scene or the track.
 */

/** The surface under a world-Z, or undefined on ordinary piste. Clamped to the
 *  track like `sectionAtZ`, since generated mountains have a finish. */
export function surfaceAtZ(track: readonly Pick<Segment, 'surface'>[], worldZ: number): Surface | undefined {
  if (track.length === 0 || !Number.isFinite(worldZ)) return undefined;
  const index = Math.min(track.length - 1, Math.max(0, Math.floor(worldZ / SEGMENT_LENGTH)));
  return track[index].surface;
}

/** Ground top-speed multiplier for a surface. Airborne riders skip this. */
export function surfaceSpeedFactor(surface: Surface | undefined): number {
  return surface === 'powder' ? POWDER_SPEED_FACTOR : 1;
}

/** Text for the HUD cue shown the moment the rider enters a surface. Words, not
 *  colour alone. */
export const SURFACE_CUES: Record<Surface, string> = {
  powder: 'POWDER · JUMP IT',
  ice: 'ICE · SLOW CARVE'
};

/** Short label for the persistent readout while on a surface. */
export const SURFACE_LABELS: Record<Surface, string> = {
  powder: 'POWDER',
  ice: 'ICE'
};

/** The cue to show when the rider moves from `previous` to `next`, if any. */
export function surfaceEntryCue(previous: Surface | undefined, next: Surface | undefined): string | null {
  return next && next !== previous ? SURFACE_CUES[next] : null;
}
