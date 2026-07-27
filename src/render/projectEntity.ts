import { ROAD_WIDTH, SEGMENT_LENGTH } from '../config';
import { roadElevationAt, Segment } from '../track/segment';
import { project, ProjectedPoint } from './project';
import { DrawnSegment } from './RoadRenderer';

/** Camera state for a frame — the same triple the road is rendered with. */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

/**
 * Projects a world-space entity (obstacle here; AI riders / pickups in Tasks
 * 7-8 reuse this) into screen space with the SAME projection math the road uses
 * (design-spec §3.5), so the sprite shrinks/grows and slides laterally through
 * curves exactly as the road does.
 *
 * `laneFraction` is the entity's lateral offset from road centre as a fraction
 * of road half-width (e.g. one of `LANES`). `worldZ` is its world-Z. `track`
 * supplies the road elevation under it. `drawnSegments` is this frame's
 * offset-walk map from `RoadRenderer` — the entity's curve offset is
 * interpolated between its segment's near/far offsets by fractional Z (§3.5's
 * "interpolated, not snapped" rule), NOT quantized to one per-segment value.
 *
 * Returns `null` — i.e. HIDE the sprite — when the entity is behind the camera,
 * beyond draw distance (its segment absent from `drawnSegments`), or on a
 * crest-clipped segment (§3.4/§3.5). The three hiding cases are all covered
 * here so callers never float a sprite over a hidden crest.
 */
export function projectEntity(
  laneFraction: number,
  worldZ: number,
  track: Segment[],
  drawnSegments: Map<number, DrawnSegment>,
  camera: Camera,
  /**
   * Height above the road surface, in world units. Defaults to 0 (planted on
   * the piste). Non-zero lifts the entity off the surface — needed for
   * airborne riders and for anything that has to be positioned relative to
   * the ground rather than on it.
   */
  heightOffset = 0,
  /**
   * When true, a crest-clipped segment still projects instead of returning
   * null. An airborne rider cresting a rise is silhouetted against the sky
   * and should stay visible even though the road *under* it is hidden;
   * without this it pops out of existence at the top of every jump.
   */
  ignoreCrestClip = false
): ProjectedPoint | null {
  const segIndex = Math.floor(worldZ / SEGMENT_LENGTH);
  const drawn = drawnSegments.get(segIndex);
  if (!drawn) {
    return null; // beyond draw distance or behind the camera
  }
  if (drawn.clipped && !ignoreCrestClip) {
    return null; // hidden behind a crest
  }

  // Fractional Z within the segment: 0 at its near edge, 1 at its far edge.
  const frac = (worldZ - segIndex * SEGMENT_LENGTH) / SEGMENT_LENGTH;
  const curveOffset = drawn.nearOffsetX + (drawn.farOffsetX - drawn.nearOffsetX) * frac;

  const worldX = curveOffset + laneFraction * ROAD_WIDTH;
  const worldY = roadElevationAt(track, worldZ) + heightOffset;

  return project(worldX, worldY, worldZ, camera.x, camera.y, camera.z);
}

/**
 * Compresses a sprite's on-screen scale so nothing can blow up to fill the
 * frame in the near field.
 *
 * Uses a soft knee rather than `Math.min`. A hard clamp produces a visible
 * derivative discontinuity the instant it engages — the sprite grows normally,
 * then abruptly freezes — which reads as more broken than the overscale it is
 * fixing. This eases into the ceiling instead: below roughly half the maximum
 * it is within a few percent of linear, and it approaches `maxPx`
 * asymptotically without ever snapping.
 */
export function softClampWidth(widthPx: number, maxPx: number): number {
  if (widthPx <= 0 || maxPx <= 0) {
    return 0;
  }
  return maxPx * (1 - Math.exp(-widthPx / maxPx));
}
