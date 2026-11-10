import { ICE_EDGE_MARGIN_SEGMENTS, ICE_MAX_SEGMENTS, ICE_MIN_SEGMENTS, ICE_TREE_FREE_SEGMENTS } from '../config';
import type { Obstacle } from '../entities/obstacle';
import type { MountainSection } from './mountain';
import { mulberry32, Prng, randInt } from './prng';
import { firstUnpassableRow } from './rows';
import type { Segment } from './segment';

/** Mixed into the course seed so ice draws from its own stream. */
const ICE_STREAM_SALT = 0x3c6ef372;

/**
 * The seeded stream ice placement draws from, derived from the course seed
 * rather than taken from the shared generator (as `powderStream` and
 * `pickupStream` do). Where ice goes and how long it is can therefore never
 * shift a geometry, obstacle-draw or rival draw.
 */
export function iceStream(seed: number): Prng {
  return mulberry32((seed ^ ICE_STREAM_SALT) >>> 0);
}

export interface IceSheet {
  /** Index into the course's sections: always a ridge section. */
  sectionIndex: number;
  /** First ice segment. */
  start: number;
  /** Ice segments, `ICE_MIN_SEGMENTS`..`ICE_MAX_SEGMENTS`. */
  length: number;
  /** Obstacles removed from rows inside the sheet to keep it passable under the
   *  ice lane-change cost. 0 when the sheet was chosen where nothing had to move. */
  thinned: number;
}

export interface IceInput {
  segments: Segment[];
  sections: readonly MountainSection[];
  crestApexes: readonly number[];
  placeableStart: number;
}

/** Maximal runs of segments with no safe zone in a section: the stretches of a
 *  ridge where obstacles can stand. Crest take-off, apex, landing (and so every
 *  steering-lock span) and the transitions are safe zones, so a sheet inside one
 *  run never overlaps a jump: riders are never airborne over ice, and the
 *  placement lock model and the ice cost never apply to the same segment. */
function openRuns(segments: readonly Segment[], section: MountainSection): [number, number][] {
  const runs: [number, number][] = [];
  let begin = -1;
  for (let i = section.startSegment; i <= section.endSegment; i++) {
    const open = i < section.endSegment && segments[i].safeZone === undefined;
    if (open && begin < 0) begin = i;
    if (!open && begin >= 0) { runs.push([begin, i]); begin = -1; }
  }
  return runs;
}

/** No forest section begins within `ICE_TREE_FREE_SEGMENTS` after the sheet, and
 *  no tree stands on it or in that margin. */
function treeFree(segments: readonly Segment[], obstacles: readonly Obstacle[], start: number, end: number): boolean {
  const limit = Math.min(segments.length, end + ICE_TREE_FREE_SEGMENTS);
  for (let s = start; s < limit; s++) if (segments[s].theme === 'forest') return false;
  return !obstacles.some((o) => o.kind === 'tree' && o.segIndex >= start && o.segIndex < limit);
}

function mark(segments: Segment[], start: number, end: number, on: boolean): void {
  for (let s = start; s < end; s++) segments[s].surface = on ? 'ice' : undefined;
}

/**
 * Make a field passable under the ice cost by removing as few obstacles as it
 * takes, each from a row INSIDE the sheet. Walks the DP, and at the first row
 * with no reachable clear lane removes the obstacle in the lowest reachable
 * (blocked) lane. A failing row outside the sheet (the first row after it, whose
 * gap now includes ice) is cured by clearing every remaining row in the sheet,
 * which leaves a gap of 20+ segments before it. Returns the surviving field and
 * the removed count, or null if even that fails (it cannot, but never loop).
 */
function thin(input: IceInput, obstacles: Obstacle[], start: number, end: number): { obstacles: Obstacle[]; removed: number } | null {
  let current = obstacles;
  let removed = 0;
  for (let guard = 0; guard < 64; guard++) {
    const failure = firstUnpassableRow(current, input.crestApexes, input.placeableStart, input.segments);
    if (!failure) return { obstacles: current, removed };
    const inside = failure.seg >= start && failure.seg < end;
    const victims = inside
      ? current.filter((o) => o.segIndex === failure.seg && o.lane === failure.arrival[0]).slice(0, 1)
      : current.filter((o) => o.segIndex >= start && o.segIndex < end);
    if (victims.length === 0) return null;
    current = current.filter((o) => !victims.includes(o));
    removed += victims.length;
  }
  return null;
}

/**
 * Ice pass (#39, part 2). Marks one ice sheet of 20-30 segments in each ridge
 * section (`surface: 'ice'` on its segments). Runs AFTER `placeObstacles` and
 * the powder pass and draws only from `stream` (`iceStream`), so geometry,
 * sections, rival parameters and every obstacle row outside a sheet are those
 * of a course without ice.
 *
 * A sheet lies wholly inside an open run of its ridge (no take-off, apex,
 * landing or transition), at least `ICE_EDGE_MARGIN_SEGMENTS` from either end,
 * and has `ICE_TREE_FREE_SEGMENTS` tree-free segments (and no forest) after it.
 *
 * On ice every lane change is charged `ICE_LANE_CHANGE_SEGMENTS`, so rows the
 * ordinary cost passed may not pass now. In order of preference:
 *  (a) the sheet goes where the existing field already passes the stricter
 *      model, from a seeded starting offset: no obstacle moves;
 *  (b) only when no position in the section does, the position that needs the
 *      fewest removals is used and those obstacles are removed from rows inside
 *      the sheet. The course is never re-rolled.
 * Returns the full obstacle list (a new array, still ordered by segment).
 */
export function placeIce(input: IceInput, obstacles: Obstacle[], stream: Prng): { obstacles: Obstacle[]; sheets: IceSheet[] } {
  const sheets: IceSheet[] = [];
  let current = obstacles;
  input.sections.forEach((section, sectionIndex) => {
    if (section.theme !== 'ridge') return;
    const wanted = randInt(stream, ICE_MIN_SEGMENTS, ICE_MAX_SEGMENTS);
    const roll = stream();
    // A shorter sheet is used only if no open run of the ridge fits the draw.
    for (let length = wanted; length >= ICE_MIN_SEGMENTS; length--) {
      const starts: number[] = [];
      for (const [begin, end] of openRuns(input.segments, section)) {
        for (let start = begin + ICE_EDGE_MARGIN_SEGMENTS; start + length + ICE_EDGE_MARGIN_SEGMENTS <= end; start++) {
          if (treeFree(input.segments, current, start, start + length)) starts.push(start);
        }
      }
      if (starts.length === 0) continue;
      const offset = Math.floor(roll * starts.length);
      const order = starts.map((_, k) => starts[(offset + k) % starts.length]);
      let chosen: { start: number; field: Obstacle[]; removed: number } | null = null;
      for (const start of order) {
        mark(input.segments, start, start + length, true);
        const failure = firstUnpassableRow(current, input.crestApexes, input.placeableStart, input.segments);
        mark(input.segments, start, start + length, false);
        if (!failure) { chosen = { start, field: current, removed: 0 }; break; }
      }
      if (!chosen) {
        for (const start of order) {
          mark(input.segments, start, start + length, true);
          const result = thin(input, current, start, start + length);
          mark(input.segments, start, start + length, false);
          if (result && (!chosen || result.removed < chosen.removed)) chosen = { start, field: result.obstacles, removed: result.removed };
        }
      }
      if (!chosen) continue;
      mark(input.segments, chosen.start, chosen.start + length, true);
      current = chosen.field;
      sheets.push({ sectionIndex, start: chosen.start, length, thinned: chosen.removed });
      return;
    }
  });
  return { obstacles: current, sheets };
}
