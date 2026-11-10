import {
  JUMP_REACH_EXTENDED,
  LANES,
  POWDER_ENTRY_MOGULS_MAX,
  POWDER_ENTRY_MOGULS_MIN,
  POWDER_MAX_SEGMENTS,
  POWDER_MIN_SEGMENTS
} from '../config';
import { Obstacle, segmentCentreZ } from '../entities/obstacle';
import type { MountainSection } from './mountain';
import { mulberry32, Prng, randInt } from './prng';
import { rowsPassable } from './rows';
import type { Segment } from './segment';

const LANE_COUNT = LANES.length;

/** Mixed into the course seed so powder draws from its own stream. */
const POWDER_STREAM_SALT = 0x6a09e667;

/** Readability floor between the entry row and any other obstacle row, the same
 *  four segments `placeObstacles` keeps between consecutive rows. */
const ENTRY_ROW_GAP = 4;
/** Segments of ordinary piste kept either side of a field inside its stretch. */
const FIELD_MARGIN = 2;

/**
 * The seeded stream powder placement draws from, derived from the course seed
 * rather than taken from the shared generator (the same decision `pickupStream`
 * made for pickups). Where powder goes, how long it is and which lanes carry the
 * entry moguls can therefore never shift a geometry, obstacle-draw or rival
 * draw: those are identical to a course without powder.
 */
export function powderStream(seed: number): Prng {
  return mulberry32((seed ^ POWDER_STREAM_SALT) >>> 0);
}

export interface PowderField {
  /** Index into the course's sections: always a bowl section. */
  sectionIndex: number;
  /** First powder segment. The entry moguls sit on it. */
  start: number;
  /** Powder segments, `POWDER_MIN_SEGMENTS`..`POWDER_MAX_SEGMENTS`. */
  length: number;
  /** Lanes holding an entry mogul on the `start` segment. */
  moguls: number[];
}

export interface PowderInput {
  segments: Segment[];
  sections: readonly MountainSection[];
  crestApexes: readonly number[];
  placeableStart: number;
}

/** The mogul rule from `placeObstacles`: nothing that ends a run (a tree) in a
 *  mogul's lane for `JUMP_REACH_EXTENDED` segments downstream of it. */
function mogulWindowClear(obstacles: readonly Obstacle[], seg: number, lanes: readonly number[]): boolean {
  return !obstacles.some((o) => o.kind === 'tree' && lanes.includes(o.lane) &&
    o.segIndex > seg && o.segIndex <= seg + JUMP_REACH_EXTENDED);
}

function combinations(size: number): number[][] {
  const out: number[][] = [];
  const walk = (from: number, chosen: number[]): void => {
    if (chosen.length === size) { out.push([...chosen]); return; }
    for (let lane = from; lane < LANE_COUNT; lane++) walk(lane + 1, [...chosen, lane]);
  };
  walk(0, []);
  return out;
}

function shuffle<T>(items: T[], stream: Prng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(stream() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Maximal runs of unprotected segments in a section: the entry hill and the
 *  exit curve of a bowl. The combat arena between them stays obstacle-free. */
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

/**
 * Powder pass (#39). Marks one powder stretch of 15-25 segments in each bowl
 * section (`surface: 'powder'` on its segments) and opens it with entry moguls
 * in two or three lanes on its first segment, so a timed trick jump carries the
 * rider over most of it.
 *
 * Runs AFTER `placeObstacles` and draws only from `stream` (`powderStream`), so
 * geometry, the obstacle draws and rival parameters are untouched; obstacles
 * change only by the entry moguls appended here. The field sits in an
 * unprotected stretch of the bowl (never the combat arena or a transition), at
 * least `ENTRY_ROW_GAP` segments from any other obstacle row, and a candidate is
 * accepted only if the whole field still passes `rowsPassable` and the mogul
 * jump-reach rule. Powder itself needs no model change: it only slows riders,
 * which can only make a row easier to reach.
 *
 * Returns the full obstacle list (a new array, still ordered by segment).
 */
export function placePowder(input: PowderInput, obstacles: Obstacle[], stream: Prng): { obstacles: Obstacle[]; fields: PowderField[] } {
  const fields: PowderField[] = [];
  let current = obstacles;
  input.sections.forEach((section, sectionIndex) => {
    if (section.theme !== 'bowl' || section.setpiece === 'runout') return;
    const length = randInt(stream, POWDER_MIN_SEGMENTS, POWDER_MAX_SEGMENTS);
    const wanted = randInt(stream, POWDER_ENTRY_MOGULS_MIN, POWDER_ENTRY_MOGULS_MAX);
    const roll = stream();
    const sizes = [wanted];
    for (let size = wanted - 1; size >= POWDER_ENTRY_MOGULS_MIN; size--) sizes.push(size);
    const laneSets = sizes.map((size) => shuffle(combinations(size), stream));

    const starts: number[] = [];
    for (const [begin, end] of openRuns(input.segments, section)) {
      for (let start = begin + FIELD_MARGIN; start + length + FIELD_MARGIN <= end; start++) starts.push(start);
    }
    const rowSegs = [...new Set(current.map((o) => o.segIndex))];
    const open = starts.filter((start) => rowSegs.every((row) => Math.abs(row - start) >= ENTRY_ROW_GAP));
    if (open.length === 0) return;
    const offset = Math.floor(roll * open.length);
    for (let k = 0; k < open.length; k++) {
      const start = open[(offset + k) % open.length];
      for (const sets of laneSets) {
        for (const lanes of sets) {
          if (!mogulWindowClear(current, start, lanes)) continue;
          const entry: Obstacle[] = lanes.map((lane) => ({ kind: 'mogul', lane, segIndex: start, z: segmentCentreZ(start) }));
          // Stable sort: every existing obstacle keeps its place in the list.
          const next = [...current, ...entry].sort((a, b) => a.segIndex - b.segIndex);
          if (!rowsPassable(next, input.crestApexes, input.placeableStart, input.segments)) continue;
          current = next;
          for (let s = start; s < start + length; s++) input.segments[s].surface = 'powder';
          fields.push({ sectionIndex, start, length, moguls: [...lanes] });
          return;
        }
      }
    }
  });
  return { obstacles: current, fields };
}
