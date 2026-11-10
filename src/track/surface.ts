import {
  ICE_LANE_CHANGE_SEGMENTS,
  ICE_LANE_TWEEN_MS,
  LANE_CHANGE_SEGMENTS,
  LANE_TWEEN_MS,
  POWDER_SPEED_FACTOR,
  SEGMENT_LENGTH
} from '../config';
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

/** How long a lane change that STARTS on this surface takes. Decided at the
 *  start of the tween and kept until it ends. Airborne riders are not on the
 *  surface: callers pass `undefined` for them. */
export function laneTweenMs(surface: Surface | undefined): number {
  return surface === 'ice' ? ICE_LANE_TWEEN_MS : LANE_TWEEN_MS;
}

/** Segments of road one lane change needs on a surface, at `MAX_SPEED`. */
export function laneChangeSegments(surface: Surface | undefined): number {
  return surface === 'ice' ? ICE_LANE_CHANGE_SEGMENTS : LANE_CHANGE_SEGMENTS;
}

/**
 * The ONE lane-change cost for the gap between two obstacle rows (or a pickup),
 * shared by `placeObstacles`, the ice pass, the pickup reachability replay and
 * `scripts/verifySolvability.ts`, so they cannot disagree.
 *
 * A rider can start a lane change anywhere in `[fromSeg, toSeg)`, so those are
 * the segments whose surface matters. A gap that is only PARTLY on ice is
 * charged the ice cost for its whole length: a slide begun on the last ice
 * segment still lasts 300 ms after the rider leaves it, and charging the dearer
 * cost throughout is always the safe direction. (The cheaper lane changes the
 * off-ice part would allow are simply not credited.) `segments` is optional so
 * geometry-only fixtures keep the ordinary cost.
 */
export function gapLaneChangeSegments(segments: readonly Pick<Segment, 'surface'>[] | undefined,
  fromSeg: number, toSeg: number): number {
  if (segments) {
    for (let s = Math.max(0, fromSeg); s < toSeg && s < segments.length; s++) {
      if (segments[s].surface === 'ice') return laneChangeSegments('ice');
    }
  }
  return laneChangeSegments(undefined);
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

/** What the persistent tag says about a surface, in words: powder caps pace,
 *  ice slows the carve and doubles close calls. Airborne riders are exempt from
 *  both, and the tag says so. */
export function surfaceTagDetail(surface: Surface, airborne: boolean | undefined): string {
  if (surface === 'ice') return airborne ? 'AIRBORNE · NO SLIDE' : 'SLOW CARVE · CLOSE CALLS x2';
  return airborne ? 'AIRBORNE · NO DRAG' : `PACE CAPPED ${Math.round(surfaceSpeedFactor(surface) * 100)}%`;
}

/** The cue to show when the rider moves from `previous` to `next`, if any. */
export function surfaceEntryCue(previous: Surface | undefined, next: Surface | undefined): string | null {
  return next && next !== previous ? SURFACE_CUES[next] : null;
}
