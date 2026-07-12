import { LANES, SEGMENT_LENGTH } from '../config';

/**
 * Obstacle kinds (design-spec §4.4). Each collides differently and only
 * rocks/moguls are jumpable — a tree is a run-ending wipeout even mid-air.
 */
export type ObstacleKind = 'tree' | 'rock' | 'mogul';

/**
 * A single placed obstacle (design-spec §4.2/§4.4). Lives in world coordinates
 * like every other entity (§3.5): a lane (→ lateral offset) and a world-Z. The
 * `segIndex` is retained so the renderer can cheaply test whether the
 * obstacle's segment was crest-clipped this frame, and so placement/verification
 * can reason in segment units.
 */
export interface Obstacle {
  kind: ObstacleKind;
  /** Lane index into `LANES` (0..LANES.length-1). */
  lane: number;
  /** Segment index this obstacle sits in. */
  segIndex: number;
  /** World-Z of the obstacle, at the CENTRE of its segment. */
  z: number;
}

/** Whether a kind can be cleared by an airborne player (design-spec §4.4). */
export function isJumpable(kind: ObstacleKind): boolean {
  return kind === 'rock' || kind === 'mogul';
}

/** World-Z of the centre of a segment — where obstacles sit for a symmetric
 *  collision window within the segment. */
export function segmentCentreZ(segIndex: number): number {
  return segIndex * SEGMENT_LENGTH + SEGMENT_LENGTH / 2;
}

/** Lateral offset fraction (of road half-width) of a lane index — the single
 *  source of truth every entity (obstacles, pickups, riders) converts a lane
 *  index through, so a future change to `LANES`' semantics only needs to be
 *  handled here. */
export function laneFraction(lane: number): number {
  return LANES[lane];
}

/** Lateral offset fraction (of road half-width) of an obstacle's lane. */
export function obstacleLaneFraction(obstacle: Obstacle): number {
  return laneFraction(obstacle.lane);
}
