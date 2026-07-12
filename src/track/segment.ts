import { SEGMENT_LENGTH } from '../config';

// A single slice of road (design-spec §3.1).
export interface Segment {
  /** Position of this segment in the track array. */
  index: number;
  /** Signed curve strength (negative = left, positive = right); accumulated
   *  into the per-segment horizontal offset walk (design-spec §3.3). */
  curve: number;
  /** World elevation at the segment's FAR edge. A segment's near-edge
   *  elevation is the previous segment's far-edge `y` (design-spec §3.4). */
  y: number;
  /** World-Z of the segment's near edge (`index * SEGMENT_LENGTH`). */
  z: number;
  /** Alternates every few segments to drive alternating snow/rumble shading. */
  colorBand: 0 | 1;
  /** Marks the single final segment of a generated course (design-spec
   *  §4.2) — where the finish banner is projected and crossing is detected.
   *  Absent/false on every other segment (including the hand-built sampler
   *  track, which has no finish line). */
  isFinish?: boolean;
}

/**
 * Road elevation directly under a world-Z position (design-spec §3.4).
 *
 * Each segment's `y` is its far-edge elevation, so the elevation under `z` is
 * a linear interpolation between the containing segment's near edge (the
 * previous segment's far `y`) and its own far `y`, by the fractional position
 * within the segment. The camera's `camY` is this value plus a fixed height,
 * so the horizon rises and falls as the player crests hills.
 *
 * `z` is wrapped into the looping track, matching the renderer's draw loop.
 */
export function roadElevationAt(track: Segment[], z: number): number {
  if (track.length === 0) {
    return 0;
  }

  const len = track.length;
  const trackLength = len * SEGMENT_LENGTH;
  const zMod = ((z % trackLength) + trackLength) % trackLength;
  const baseIndex = Math.floor(zMod / SEGMENT_LENGTH) % len;
  const fraction = (zMod % SEGMENT_LENGTH) / SEGMENT_LENGTH;

  const nearY = track[(baseIndex - 1 + len) % len].y;
  const farY = track[baseIndex].y;

  return nearY + (farY - nearY) * fraction;
}
