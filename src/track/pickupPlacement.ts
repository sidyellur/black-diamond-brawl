import { LANES, PICKUP_MAX_GAP_SEGMENTS, PICKUP_MIN_GAP_SEGMENTS } from '../config';
import { Obstacle, segmentCentreZ } from '../entities/obstacle';
import { Pickup } from '../entities/pickup';
import { Prng, randInt } from './prng';

const LANE_COUNT = LANES.length;
const ALL_LANES: number[] = Array.from({ length: LANE_COUNT }, (_, i) => i);

export interface PickupPlacementInput {
  /** The FINAL placed obstacle field, so pickups can prefer a lane the
   *  obstacle placement pass left clear at the same segment. */
  obstacles: Obstacle[];
  placeableStart: number;
  placeableEnd: number;
}

/**
 * Pickup placement pass (design-spec §4.2/§4.6). Draws from the SAME `prng`
 * the geometry/obstacle passes already advanced — must run after both, per
 * §4.2's PRNG draw-order discipline (placement draws never interleave with
 * geometry, and every placement draw — obstacles, pickups, AI params — comes
 * from the one seeded generator). Spawns a pickup on a clear lane roughly
 * every 300-450 segments (~20-30s of travel at MAX_SPEED).
 *
 * Unlike obstacle placement, pickups have no solvability requirement to
 * enforce (driving over one is never a hazard, so worst case a lane pick
 * coincides with an obstacle row and just skips that lane) — unrelated to
 * the reachability guarantee `placement.ts` builds for obstacles.
 */
export function placePickups(input: PickupPlacementInput, prng: Prng): Pickup[] {
  const { obstacles, placeableStart, placeableEnd } = input;
  const pickups: Pickup[] = [];
  if (placeableEnd <= placeableStart) {
    return pickups;
  }

  let seg = placeableStart;
  while (seg < placeableEnd) {
    seg += randInt(prng, PICKUP_MIN_GAP_SEGMENTS, PICKUP_MAX_GAP_SEGMENTS);
    if (seg >= placeableEnd) {
      break;
    }

    const blockedLanes = new Set(obstacles.filter((o) => o.segIndex === seg).map((o) => o.lane));
    const clearLanes = ALL_LANES.filter((l) => !blockedLanes.has(l));
    const candidates = clearLanes.length > 0 ? clearLanes : ALL_LANES;
    const lane = candidates[randInt(prng, 0, candidates.length - 1)];

    pickups.push({ lane, segIndex: seg, z: segmentCentreZ(seg), collected: false });
  }

  return pickups;
}
