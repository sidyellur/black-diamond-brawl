import { JUMP_REACH_EXTENDED, LANES } from '../config';
import type { Obstacle } from '../entities/obstacle';
import type { Segment } from './segment';
import { gapLaneChangeSegments } from './surface';

const LANE_COUNT = LANES.length;
const ALL_LANES: number[] = Array.from({ length: LANE_COUNT }, (_, i) => i);

function dilate(from: ReadonlySet<number>, maxShift: number): Set<number> {
  const out = new Set<number>();
  for (const lane of from) {
    for (let l = Math.max(0, lane - maxShift); l <= Math.min(LANE_COUNT - 1, lane + maxShift); l++) out.add(l);
  }
  return out;
}

export interface RowFailure {
  /** The first row with no reachable clear lane. */
  seg: number;
  /** Lanes the rider could reach on arrival, all of them blocked in that row. */
  arrival: number[];
}

type RowSegments = readonly Pick<Segment, 'surface' | 'chute'>[];

const INNER_LANES = new Set(ALL_LANES.slice(1, -1));
const onlyInner = (lanes: ReadonlySet<number>): Set<number> => new Set([...lanes].filter((l) => INNER_LANES.has(l)));

/**
 * The obstacle rows of a field, with a tree chute's walls reduced to what the
 * model needs: the wall trees are not ordinary rows (a tree every second segment
 * would give each hop 2 segments of steering, less than the 3 a lane change
 * costs, so no lane could ever be left). Only the FIRST wall row is kept, as the
 * place the funnel has to have brought the rider inward by; `advanceLanes` keeps
 * the outer lanes closed for the rest of the stretch. Returns lanes blocked per segment.
 */
export function obstacleRows(obstacles: readonly Obstacle[], segments: RowSegments | undefined): Map<number, Set<number>> {
  const rows = new Map<number, Set<number>>();
  for (const o of obstacles) {
    if (o.wall && segments?.[o.segIndex - 1]?.chute) continue;
    if (!rows.has(o.segIndex)) rows.set(o.segIndex, new Set());
    rows.get(o.segIndex)!.add(o.lane);
  }
  return rows;
}

/**
 * Lanes a rider can be in on arrival at row `seg`, from `reachable` at row `prev`.
 * `shiftOver(from, to)` is the lanes a rider can change over the steerable
 * segments in `(from, to]` (callers differ only in how they count locked
 * segments). Without a chute this is one dilation, exactly as before. A chute
 * (#39) closes lanes 0 and 4 from its first wall segment to its last: the rider
 * must be in an inner lane by then (`(prev, W]` is the whole funnel's worth of
 * lane changing), can only ever dilate within lanes 1-3 inside it, and gets
 * the outer lanes back only with the road that remains AFTER the last wall.
 */
export function advanceLanes(reachable: ReadonlySet<number>, prev: number, seg: number, segments: RowSegments | undefined,
  shiftOver: (from: number, to: number) => number): Set<number> {
  let lanes: Set<number> = new Set(reachable);
  let cursor = prev;
  if (segments) {
    for (let t = prev + 1; t <= seg; t++) {
      const was = segments[t - 1]?.chute === true;
      const now = segments[t]?.chute === true;
      if (now === was) continue;
      if (now) { // t is the first wall segment
        lanes = onlyInner(dilate(lanes, shiftOver(cursor, t)));
        cursor = t;
      } else { // t is the first segment after the last wall
        lanes = onlyInner(dilate(lanes, shiftOver(cursor, t - 1)));
        cursor = t - 1;
      }
    }
  }
  lanes = dilate(lanes, shiftOver(cursor, seg));
  return segments?.[seg]?.chute ? onlyInner(lanes) : lanes;
}

/**
 * The placement guarantee, re-checked over a finished obstacle list: every row
 * leaves a clear lane that is reachable from the previous row's clear lanes by
 * the same lane-change model `placeObstacles` builds the field with, crest
 * steering locks and the surface-dependent lane-change cost
 * (`gapLaneChangeSegments`) included, and a chute's closed outer lanes
 * (`advanceLanes`). Used by the powder, ice and chute passes, which add to or
 * re-mark a field that is already built, so every candidate has to pass exactly
 * the test the field was built under. Returns the first failing row, or null
 * when the whole field is passable. `from` starts the walk at a given segment
 * with a given set of lanes (the chute's exit: any inner lane) instead of at
 * the start of the course.
 */
export function firstUnpassableRow(obstacles: readonly Obstacle[], crestApexes: readonly number[],
  placeableStart: number, segments: RowSegments | undefined,
  from?: { lanes: readonly number[]; seg: number }): RowFailure | null {
  const rows = obstacleRows(obstacles, segments);
  const rowSegs = [...rows.keys()].filter((seg) => !from || seg > from.seg).sort((a, b) => a - b);
  const locked = new Set<number>();
  for (const apex of crestApexes) for (let s = Math.max(0, apex); s <= apex + JUMP_REACH_EXTENDED; s++) locked.add(s);
  const shiftOver = (a: number, b: number): number => {
    let steerable = 0;
    for (let s = a + 1; s <= b; s++) if (!locked.has(s)) steerable++;
    return Math.floor(steerable / gapLaneChangeSegments(segments, a, b));
  };
  let reachable: Set<number> = new Set(from ? from.lanes : ALL_LANES);
  let prev = from ? from.seg : placeableStart;
  for (const seg of rowSegs) {
    const arrival = advanceLanes(reachable, prev, seg, segments, shiftOver);
    reachable = new Set([...arrival].filter((l) => !rows.get(seg)!.has(l)));
    if (reachable.size === 0) return { seg, arrival: [...arrival].sort((a, b) => a - b) };
    prev = seg;
  }
  return null;
}

export function rowsPassable(obstacles: readonly Obstacle[], crestApexes: readonly number[],
  placeableStart: number, segments: RowSegments | undefined): boolean {
  return firstUnpassableRow(obstacles, crestApexes, placeableStart, segments) === null;
}
