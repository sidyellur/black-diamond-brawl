import {
  JUMP_REACH_EXTENDED,
  LANE_CHANGE_SEGMENTS,
  LANES,
  PICKUP_KIND_WEIGHTS,
  PICKUP_MAX_GAP_SEGMENTS,
  PICKUP_MIN_GAP_SEGMENTS
} from '../config';
import { Obstacle, segmentCentreZ } from '../entities/obstacle';
import { Pickup, PICKUP_KIND_LIST, PickupKind } from '../entities/pickup';
import { mulberry32, Prng, randInt } from './prng';

const LANE_COUNT = LANES.length;
const ALL_LANES: number[] = Array.from({ length: LANE_COUNT }, (_, i) => i);

/** Mixed into the course seed so pickups draw from their own stream. */
const PICKUP_STREAM_SALT = 0x9e3779b1;

/** The seeded stream pickup placement draws from, derived from the course seed
 *  rather than taken from the shared generator, so how many pickups a course
 *  has (and what kind they are) can never shift obstacle or rival draws. */
export function pickupStream(seed: number): Prng {
  return mulberry32((seed ^ PICKUP_STREAM_SALT) >>> 0);
}

export interface PickupPlacementInput {
  /** The FINAL placed obstacle field, so pickups can prefer a lane the
   *  obstacle placement pass left clear at the same segment. */
  obstacles: Obstacle[];
  /** Crest apexes: steering is locked while airborne off each one, and the
   *  reachability replay below must credit no lane changes across that span. */
  crestApexes: number[];
  placeableStart: number;
  placeableEnd: number;
}

function dilate(from: ReadonlySet<number>, maxShift: number): Set<number> {
  const out = new Set<number>();
  for (const lane of from) {
    for (let l = Math.max(0, lane - maxShift); l <= Math.min(LANE_COUNT - 1, lane + maxShift); l++) out.add(l);
  }
  return out;
}

/**
 * Lanes the player can actually be in at each pickup segment: clear of every
 * obstacle (trees, rocks and moguls alike) and reachable from the start by the
 * same lane-change model `placeObstacles` guarantees a path for. Replaying that
 * model here is what lets a pickup be promised "reachable without crossing a
 * tree" at the higher density, not merely "not on a tree".
 */
function reachableLaneSets(input: PickupPlacementInput, segs: number[]): Set<number>[] {
  const { obstacles, crestApexes, placeableStart, placeableEnd } = input;
  const locked = new Array<number>(placeableEnd + 2).fill(0);
  const isLocked = new Array<boolean>(placeableEnd + 1).fill(false);
  for (const apex of crestApexes) {
    for (let s = Math.max(0, apex); s <= Math.min(placeableEnd, apex + JUMP_REACH_EXTENDED); s++) isLocked[s] = true;
  }
  for (let s = 0; s <= placeableEnd; s++) locked[s + 1] = locked[s] + (isLocked[s] ? 1 : 0);

  const rows = new Map<number, Set<number>>();
  for (const o of obstacles) {
    if (!rows.has(o.segIndex)) rows.set(o.segIndex, new Set());
    rows.get(o.segIndex)!.add(o.lane);
  }
  const rowSegs = [...rows.keys()].sort((a, b) => a - b);

  const steer = (from: number, to: number): number => {
    const lockedInGap = locked[to + 1] - locked[from + 1];
    return Math.floor(Math.max(0, to - from - lockedInGap) / LANE_CHANGE_SEGMENTS);
  };

  let reachable: Set<number> = new Set(ALL_LANES);
  let prevRow = placeableStart;
  let next = 0;
  const result: Set<number>[] = [];
  for (const seg of segs) {
    // Advance through every obstacle row strictly before this pickup.
    while (next < rowSegs.length && rowSegs[next] < seg) {
      const row = rowSegs[next++];
      const arrival = dilate(reachable, steer(prevRow, row));
      reachable = new Set([...arrival].filter((l) => !rows.get(row)!.has(l)));
      prevRow = row;
    }
    const arrival = dilate(reachable, steer(prevRow, seg));
    const here = rows.get(seg);
    result.push(here ? new Set([...arrival].filter((l) => !here.has(l))) : arrival);
  }
  return result;
}

function pickKind(prng: Prng): PickupKind {
  const total = PICKUP_KIND_LIST.reduce((sum, kind) => sum + PICKUP_KIND_WEIGHTS[kind], 0);
  let roll = prng() * total;
  for (const kind of PICKUP_KIND_LIST) {
    roll -= PICKUP_KIND_WEIGHTS[kind];
    if (roll < 0) return kind;
  }
  return PICKUP_KIND_LIST[PICKUP_KIND_LIST.length - 1];
}

/**
 * Pickup placement pass (design-spec §4.2/§4.6, #36). Draws from `stream`, a
 * stream derived from the course seed (`pickupStream`), NOT the shared
 * generator, so it never interleaves with geometry, obstacle or rival draws.
 * Each pickup draws its gap, then its lane, THEN its kind, in that order, so
 * position logic stays comparable across kind changes.
 *
 * Fairness: a pickup's lane is chosen only from lanes that are obstacle-free at
 * its segment AND reachable by the lane-change model obstacle placement already
 * guarantees a route through — so every pickup can be collected without
 * crossing a tree (stricter than needed: rocks and moguls are excluded too).
 * That set is never empty: it contains every lane the guaranteed clear route
 * can be in.
 */
export function placePickups(input: PickupPlacementInput, stream: Prng): Pickup[] {
  const { placeableStart, placeableEnd } = input;
  const pickups: Pickup[] = [];
  if (placeableEnd <= placeableStart) {
    return pickups;
  }

  const segs: number[] = [];
  const laneRolls: number[] = [];
  const kinds: PickupKind[] = [];
  // The lane draw is one raw value, mapped onto the candidate lanes once the
  // reachable sets (which need every segment) are known. The draw order is
  // still gap, lane, kind for each pickup.
  let seg = placeableStart;
  while (seg < placeableEnd) {
    seg += randInt(stream, PICKUP_MIN_GAP_SEGMENTS, PICKUP_MAX_GAP_SEGMENTS);
    if (seg >= placeableEnd) break;
    segs.push(seg);
    laneRolls.push(stream());
    kinds.push(pickKind(stream));
  }
  const reachable = reachableLaneSets(input, segs);
  segs.forEach((s, i) => {
    const candidates = [...reachable[i]].sort((a, b) => a - b);
    const pool = candidates.length > 0 ? candidates : ALL_LANES;
    const lane = pool[Math.min(pool.length - 1, Math.floor(laneRolls[i] * pool.length))];
    pickups.push({ kind: kinds[i], lane, segIndex: s, z: segmentCentreZ(s), collected: false });
  });
  return pickups;
}

/**
 * Advances the shared generator exactly as the pre-#36 pickup pass did (about
 * three pickups a course: gap draw, then lane draw), discarding the result.
 * Rival parameters are drawn AFTER this pass from the same generator, so
 * skipping it would re-roll every rival for every seed. Keeping the draws
 * means obstacles AND rivals stay byte-identical to `mountain-v2` for a given
 * seed; only the pickup list itself changes.
 */
export function skipLegacyPickupDraws(obstacles: Obstacle[], placeableStart: number,
  placeableEnd: number, prng: Prng): void {
  if (placeableEnd <= placeableStart) return;
  let seg = placeableStart;
  while (seg < placeableEnd) {
    seg += randInt(prng, 300, 450);
    if (seg >= placeableEnd) break;
    const blocked = new Set(obstacles.filter((o) => o.segIndex === seg).map((o) => o.lane));
    const clear = ALL_LANES.filter((l) => !blocked.has(l));
    randInt(prng, 0, (clear.length > 0 ? clear.length : ALL_LANES.length) - 1);
  }
}
