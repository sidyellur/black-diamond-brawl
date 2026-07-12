import {
  BLIND_LANDING_SEGMENTS,
  COURSE_LENGTH_SEGMENTS,
  JUMP_REACH_EXTENDED,
  LANE_CHANGE_SEGMENTS,
  LANES,
  OBSTACLE_ROWS_PER_100_END,
  OBSTACLE_ROWS_PER_100_START
} from '../config';
import { Obstacle, ObstacleKind, segmentCentreZ } from '../entities/obstacle';
import { Prng } from './prng';

const LANE_COUNT = LANES.length;
const ALL_LANES: number[] = Array.from({ length: LANE_COUNT }, (_, i) => i);

// Never place two consecutive rows closer than this — keeps rows visually
// distinct. Reachability is guaranteed independently (see below), so this is a
// readability floor, not a safety one.
const MIN_ROW_GAP = 4;

// Per-blocked-lane obstacle kind weights (design-spec doesn't fix a mix; rocks
// are the friendliest, so they dominate; trees are the run-enders, kept rarer).
const KIND_WEIGHTS: Record<ObstacleKind, number> = {
  rock: 45,
  tree: 30,
  mogul: 25
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const randInt = (prng: Prng, min: number, max: number): number =>
  Math.floor(min + prng() * (max - min + 1));

/** Fisher–Yates shuffle driven by the seeded PRNG (in place). */
function shuffle<T>(arr: T[], prng: Prng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Weighted kind pick. */
function pickKind(prng: Prng): ObstacleKind {
  const kinds = Object.keys(KIND_WEIGHTS) as ObstacleKind[];
  const total = kinds.reduce((s, k) => s + KIND_WEIGHTS[k], 0);
  let roll = prng() * total;
  for (const k of kinds) {
    roll -= KIND_WEIGHTS[k];
    if (roll <= 0) {
      return k;
    }
  }
  return kinds[kinds.length - 1];
}

/** Lanes reachable from `from` given the player can shift `maxShift` lanes. */
function dilate(from: Set<number>, maxShift: number): Set<number> {
  const out = new Set<number>();
  for (const lane of from) {
    const lo = Math.max(0, lane - maxShift);
    const hi = Math.min(LANE_COUNT - 1, lane + maxShift);
    for (let l = lo; l <= hi; l++) {
      out.add(l);
    }
  }
  return out;
}

export interface PlacementInput {
  crestApexes: number[];
  /** First segment index obstacles may occupy (after the warm-up). */
  placeableStart: number;
  /** One past the last segment index obstacles may occupy (before the
   *  return-to-flat / run-out / finish tail). */
  placeableEnd: number;
}

/**
 * Placement pass (design-spec §4.2). Draws from the SAME `prng` the geometry
 * pass already advanced — it must be called strictly after `buildGeometry`
 * completes so course determinism holds (§4.2 PRNG draw-order discipline).
 *
 * Safety guarantee (this is the safety-critical part of Task 6): the generated
 * obstacle field always leaves a survivable, *reachable* clear line. This is
 * enforced constructively via a reachability DP that maintains, per row, the
 * set of lanes the player could occupy having dodged every prior row; each new
 * row is placed so that set stays non-empty (a `safe` clear lane is always
 * chosen from the currently-reachable set), which by induction guarantees a
 * clear path from start to finish exists — never merely "a clear lane exists"
 * but one reachable in time (§4.2's quantified rule).
 *
 * Hard tree constraints also enforced: no tree in a mogul's lane within
 * `JUMP_REACH_EXTENDED` segments downstream of it, and every lane obstacle-free
 * for `BLIND_LANDING_SEGMENTS` after each crest apex (which, being ≥ 18, also
 * covers the crest jump-reach rule).
 *
 * Crest steering-lock (safety-critical): crossing a jumpable crest apex
 * auto-launches the player into an extended, *steering-locked* airborne span of
 * ~`JUMP_REACH_EXTENDED` segments (see `RaceScene` crest auto-launch and
 * `Player.requestLaneShift` dropping input while `airborne`). The reachability
 * DP must NOT credit the player with lane-change distance across those locked
 * segments — they cannot steer at all there — so a gap that traverses a lock
 * span only offers its *non-locked* segments' worth of steering. Modelling this
 * makes the safety guarantee correct by construction rather than relying on the
 * blind-landing buffer incidentally absorbing the lock.
 */
export function placeObstacles(input: PlacementInput, prng: Prng): Obstacle[] {
  const { crestApexes, placeableStart, placeableEnd } = input;
  const obstacles: Obstacle[] = [];
  if (placeableEnd <= placeableStart) {
    return obstacles;
  }

  // Segments where NO obstacle of any kind may sit: the blind landing zone of
  // every crest apex (the apex itself plus BLIND_LANDING_SEGMENTS after it —
  // the apex is the launch point, the rest is the obstacle-free landing).
  const forbidden = new Array<boolean>(placeableEnd).fill(false);
  for (const apex of crestApexes) {
    const end = Math.min(placeableEnd - 1, apex + BLIND_LANDING_SEGMENTS);
    for (let s = apex; s <= end; s++) {
      if (s >= 0) {
        forbidden[s] = true;
      }
    }
  }

  // Segments during which STEERING is locked: the auto-launch airborne span of
  // each crest apex, [apex, apex + JUMP_REACH_EXTENDED]. Derived from
  // JUMP_REACH_EXTENDED independently of BLIND_LANDING_SEGMENTS, so the DP stays
  // correct even if the blind buffer is later shrunk below the lock length. The
  // apex segment itself is included (conservative — it can only *reduce* the
  // credited steering distance, which is the safe direction).
  const lockedPrefix = new Array<number>(placeableEnd + 1).fill(0);
  const isLocked = new Array<boolean>(placeableEnd).fill(false);
  for (const apex of crestApexes) {
    const end = Math.min(placeableEnd - 1, apex + JUMP_REACH_EXTENDED);
    for (let s = Math.max(0, apex); s <= end; s++) {
      isLocked[s] = true;
    }
  }
  for (let s = 0; s < placeableEnd; s++) {
    lockedPrefix[s + 1] = lockedPrefix[s] + (isLocked[s] ? 1 : 0);
  }

  // Reachability DP state: lanes the player could be in at the current row.
  // Before the first row the player has the whole warm-up to reach any lane.
  let reachable = new Set<number>(ALL_LANES);
  let prevRowSeg = placeableStart;

  // Per-lane segment index up to which a TREE is forbidden (a mogul upstream
  // needs a tree-free landing in its own lane for JUMP_REACH_EXTENDED segments).
  const treeForbiddenUntil = new Array<number>(LANE_COUNT).fill(-1);

  let seg = placeableStart;
  while (seg < placeableEnd) {
    const t = seg / COURSE_LENGTH_SEGMENTS;
    const rowsPer100 = lerp(OBSTACLE_ROWS_PER_100_START, OBSTACLE_ROWS_PER_100_END, t);
    const expectedGap = 100 / rowsPer100;
    const lo = Math.max(MIN_ROW_GAP, Math.round(expectedGap * 0.6));
    const hi = Math.max(lo + 2, Math.round(expectedGap * 1.4));
    seg += randInt(prng, lo, hi);

    // Skip forbidden (blind-landing) segments — advance to the next placeable
    // one. Growing the gap only makes the next row *more* reachable.
    while (seg < placeableEnd && forbidden[seg]) {
      seg++;
    }
    if (seg >= placeableEnd) {
      break;
    }

    const gapSeg = seg - prevRowSeg;
    // Steering is impossible across any crest lock span this gap traverses, so
    // the player can only use the NON-locked portion of the gap to change
    // lanes. Count locked segments in (prevRowSeg, seg] and subtract them.
    const lockedInGap = lockedPrefix[seg + 1] - lockedPrefix[prevRowSeg + 1];
    const steerableGap = Math.max(0, gapSeg - lockedInGap);
    const maxShift = Math.floor(steerableGap / LANE_CHANGE_SEGMENTS);
    const arrival = dilate(reachable, maxShift);

    // A guaranteed-clear lane, chosen from the lanes actually reachable here.
    const arrivalArr = [...arrival];
    const safe = arrivalArr[randInt(prng, 0, arrivalArr.length - 1)];

    // How many lanes to block this row: ramps from 1 (t=0) up to 3 (t=1),
    // always leaving ≥1 clear lane (`safe`).
    const maxBlock = Math.min(LANE_COUNT - 1, 1 + Math.round(2 * t));
    const blockCount = randInt(prng, 1, maxBlock);

    const candidates = shuffle(ALL_LANES.filter((l) => l !== safe), prng);
    const blocked = candidates.slice(0, blockCount);

    for (const lane of blocked) {
      let kind = pickKind(prng);
      // Enforce the tree jump-reach constraint: a tree may not sit in a lane
      // still inside a mogul's downstream launch window — demote it to a rock.
      if (kind === 'tree' && seg <= treeForbiddenUntil[lane]) {
        kind = 'rock';
      }
      obstacles.push({ kind, lane, segIndex: seg, z: segmentCentreZ(seg) });
      if (kind === 'mogul') {
        treeForbiddenUntil[lane] = Math.max(treeForbiddenUntil[lane], seg + JUMP_REACH_EXTENDED);
      }
    }

    // Survivable lanes at this row = clear AND reachable. Contains `safe`, so
    // it is never empty — this is the invariant the safety guarantee rests on.
    const blockedSet = new Set(blocked);
    reachable = new Set(ALL_LANES.filter((l) => !blockedSet.has(l) && arrival.has(l)));
    prevRowSeg = seg;
  }

  return obstacles;
}
