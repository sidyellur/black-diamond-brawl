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

/**
 * The placement guarantee, re-checked over a finished obstacle list: every row
 * leaves a clear lane that is reachable from the previous row's clear lanes by
 * the same lane-change model `placeObstacles` builds the field with, crest
 * steering locks and the surface-dependent lane-change cost
 * (`gapLaneChangeSegments`) included. Used by the powder and ice passes, which
 * add to or re-mark a field that is already built, so every candidate has to
 * pass exactly the test the field was built under. Returns the first failing
 * row, or null when the whole field is passable.
 */
export function firstUnpassableRow(obstacles: readonly Obstacle[], crestApexes: readonly number[],
  placeableStart: number, segments: readonly Pick<Segment, 'surface'>[] | undefined): RowFailure | null {
  const rows = new Map<number, Set<number>>();
  for (const o of obstacles) {
    if (!rows.has(o.segIndex)) rows.set(o.segIndex, new Set());
    rows.get(o.segIndex)!.add(o.lane);
  }
  const rowSegs = [...rows.keys()].sort((a, b) => a - b);
  const locked = new Set<number>();
  for (const apex of crestApexes) for (let s = Math.max(0, apex); s <= apex + JUMP_REACH_EXTENDED; s++) locked.add(s);
  let reachable: Set<number> = new Set(ALL_LANES);
  let prev = placeableStart;
  for (const seg of rowSegs) {
    let steerable = 0;
    for (let s = prev + 1; s <= seg; s++) if (!locked.has(s)) steerable++;
    const arrival = dilate(reachable, Math.floor(steerable / gapLaneChangeSegments(segments, prev, seg)));
    reachable = new Set([...arrival].filter((l) => !rows.get(seg)!.has(l)));
    if (reachable.size === 0) return { seg, arrival: [...arrival].sort((a, b) => a - b) };
    prev = seg;
  }
  return null;
}

export function rowsPassable(obstacles: readonly Obstacle[], crestApexes: readonly number[],
  placeableStart: number, segments: readonly Pick<Segment, 'surface'>[] | undefined): boolean {
  return firstUnpassableRow(obstacles, crestApexes, placeableStart, segments) === null;
}
