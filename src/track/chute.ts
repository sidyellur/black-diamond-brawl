import {
  CHUTE_AWARENESS_SEGMENTS,
  CHUTE_BOOSTED_FLIGHT_SEGMENTS,
  CHUTE_FUNNEL_SEGMENTS,
  CHUTE_INNER_LEAD_SEGMENTS,
  CHUTE_MAX_SEGMENTS,
  CHUTE_MIN_SEGMENTS,
  CHUTE_MOGUL_MARGIN_SEGMENTS,
  CHUTE_PICKUP_BUFFER_SEGMENTS,
  CHUTE_WALL_SPACING,
  LANES,
  ROCK_LOCK_SEGMENTS,
  SEGMENT_LENGTH
} from '../config';
import { Obstacle, segmentCentreZ } from '../entities/obstacle';
import type { MountainSection } from './mountain';
import { mulberry32, Prng, randInt } from './prng';
import { firstUnpassableRow } from './rows';
import type { Segment } from './segment';
import { gapLaneChangeSegments } from './surface';

const LANE_COUNT = LANES.length;
const FIRST_OUTER = 0;
const LAST_OUTER = LANE_COUNT - 1;
/** The rideable lanes inside a chute. */
export const CHUTE_INNER_LANES: readonly number[] = Array.from({ length: LANE_COUNT - 2 }, (_, i) => i + 1);

/** Mixed into the course seed so the chute draws from its own stream. */
const CHUTE_STREAM_SALT = 0x510e527f;

/**
 * The seeded stream chute placement draws from, derived from the course seed
 * rather than taken from the shared generator (the same decision `powderStream`,
 * `iceStream` and `pickupStream` made). Where the chute goes, how long it is and
 * which inner obstacles it holds can therefore never shift a geometry,
 * obstacle-draw or rival draw.
 */
export function chuteStream(seed: number): Prng {
  return mulberry32((seed ^ CHUTE_STREAM_SALT) >>> 0);
}

export interface Chute {
  /** Index into the course's sections: always a forest section, never the warm-up. */
  sectionIndex: number;
  /** First funnel segment: the first of `CHUTE_FUNNEL_SEGMENTS` obstacle-free, pole-marked segments. */
  funnelStart: number;
  /** First walled segment (= `funnelStart + CHUTE_FUNNEL_SEGMENTS`); the first wall tree stands on it. */
  start: number;
  /** Walled segments, `CHUTE_MIN_SEGMENTS`..`CHUTE_MAX_SEGMENTS`. */
  length: number;
  /** Wall trees placed (both sides). */
  walls: number;
  /** Rocks and moguls placed in the inner lanes. */
  inner: number;
  /** Original obstacles removed from the funnel and walled stretch. */
  removed: number;
  /** Outer-lane moguls just before the funnel demoted to rocks (they would launch a rider into the wall). */
  demoted: number;
  /** Rows after the chute removed so it can be left from any inner lane. 0 when none had to move. */
  thinned: number;
}

export interface ChuteInput {
  segments: Segment[];
  sections: readonly MountainSection[];
  crestApexes: readonly number[];
  placeableStart: number;
}

/** First segment AFTER the walled stretch. */
export const chuteEnd = (chute: Pick<Chute, 'start' | 'length'>): number => chute.start + chute.length;

/** Whether `obstacle` is one of a chute's wall trees. */
export function isChuteWall(obstacle: Obstacle): boolean { return obstacle.wall === true; }

/** True when a rider at `seg` is in, or within `CHUTE_AWARENESS_SEGMENTS` of, a chute's walls:
 *  the outer lanes are closed or about to be. Rivals and the entry cue read this; entities are
 *  handed the answer, never the track. */
export function chuteAhead(track: readonly Pick<Segment, 'chute'>[], worldZ: number): boolean {
  if (track.length === 0 || !Number.isFinite(worldZ)) return false;
  const seg = Math.min(track.length - 1, Math.max(0, Math.floor(worldZ / SEGMENT_LENGTH)));
  for (let s = seg; s <= seg + CHUTE_AWARENESS_SEGMENTS && s < track.length; s++) if (track[s].chute) return true;
  return false;
}

/** Whether the rider is on a chute segment (funnel or walls): the HUD cue's trigger. */
export function inChute(track: readonly Pick<Segment, 'chute' | 'chuteFunnel'>[], worldZ: number): boolean {
  if (track.length === 0 || !Number.isFinite(worldZ)) return false;
  const segment = track[Math.min(track.length - 1, Math.max(0, Math.floor(worldZ / SEGMENT_LENGTH)))];
  return !!(segment.chute || segment.chuteFunnel);
}

/** Whether a pickup at `seg` may not sit in an outer lane: inside the walls, or in the stretch of
 *  funnel where reaching it would leave too little road to come back inward. */
export function outerLanesClosed(segments: readonly Pick<Segment, 'chute'>[] | undefined, seg: number): boolean {
  if (!segments) return false;
  for (let s = seg; s <= seg + CHUTE_PICKUP_BUFFER_SEGMENTS && s < segments.length; s++) if (segments[s]?.chute) return true;
  return false;
}

export const CHUTE_CUE = 'CHUTE · THREE LANES';
/** The cue to show when the rider moves from outside a chute to its funnel or walls. */
export function chuteEntryCue(previous: boolean, next: boolean): string | null {
  return next && !previous ? CHUTE_CUE : null;
}

function mark(segments: Segment[], funnelStart: number, start: number, end: number, on: boolean): void {
  for (let s = funnelStart; s < end; s++) {
    if (s < start) segments[s].chuteFunnel = on ? true : undefined;
    else segments[s].chute = on ? true : undefined;
  }
}

/** Maximal runs of segments with no safe zone in a section: where obstacles may stand. */
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

const dilate = (from: ReadonlySet<number>, maxShift: number): Set<number> => {
  const out = new Set<number>();
  for (const lane of from) {
    for (let l = Math.max(0, lane - maxShift); l <= Math.min(LANE_COUNT - 1, lane + maxShift); l++) out.add(l);
  }
  return out;
};

/** Whether a rock or mogul at (`seg`, `lane`) stays clear of the trees the field already has downstream:
 *  none in its lane within the jump reach (mogul) or no-steer window (rock), the two rules
 *  `placeObstacles` builds the field under. */
function windowClear(trees: readonly Obstacle[], kind: 'rock' | 'mogul', seg: number, lane: number): boolean {
  // A mogul's flight is taken at the fastest rider's speed, not `MAX_SPEED`'s 18 segments.
  const reach = kind === 'mogul' ? CHUTE_BOOSTED_FLIGHT_SEGMENTS - 1 : ROCK_LOCK_SEGMENTS;
  return !trees.some((t) => t.lane === lane && t.segIndex > seg && t.segIndex <= seg + reach);
}

/**
 * The inner rows of a chute: occasional rocks and moguls in lanes 1-3, never a
 * tree, with at least one inner lane clear (and reachable) in every row. Rows are
 * 6-9 segments apart, the first `CHUTE_INNER_LEAD_SEGMENTS` into the walls, and
 * walked with the same lane-change model as everything else; a rock or mogul that
 * would stand within reach of a tree downstream of the chute is simply not placed.
 */
function innerRows(start: number, length: number, after: readonly Obstacle[], stream: Prng): Obstacle[] {
  const treesAfter = after.filter((o) => o.kind === 'tree');
  const rows: Obstacle[] = [];
  let reachable: Set<number> = new Set(CHUTE_INNER_LANES);
  let prev = start;
  let seg = start + CHUTE_INNER_LEAD_SEGMENTS + randInt(stream, 0, 2);
  while (seg < start + length - 3) {
    const arrival = dilate(reachable, Math.floor((seg - prev) / gapLaneChangeSegments(undefined, prev, seg)));
    const open = CHUTE_INNER_LANES.filter((lane) => arrival.has(lane));
    const safe = open[randInt(stream, 0, open.length - 1)];
    const others = CHUTE_INNER_LANES.filter((lane) => lane !== safe);
    // Usually one obstacle, sometimes two; shuffled so the side varies.
    const count = stream() < 0.35 ? others.length : 1;
    const order = others.map((lane) => ({ lane, key: stream() })).sort((a, b) => a.key - b.key).map((x) => x.lane);
    const blocked: number[] = [];
    for (const lane of order.slice(0, count)) {
      const wantMogul = stream() < 0.4;
      const kind = wantMogul && windowClear(treesAfter, 'mogul', seg, lane) ? 'mogul'
        : windowClear(treesAfter, 'rock', seg, lane) ? 'rock' : null;
      if (!kind) continue;
      rows.push({ kind, lane, segIndex: seg, z: segmentCentreZ(seg) });
      blocked.push(lane);
    }
    reachable = new Set(CHUTE_INNER_LANES.filter((lane) => arrival.has(lane) && !blocked.includes(lane)));
    prev = seg;
    seg += randInt(stream, 6, 9);
  }
  return rows;
}

interface Candidate {
  funnelStart: number;
  field: Obstacle[];
  chute: Omit<Chute, 'sectionIndex'>;
}

/** One position, fully built and checked, or null if it cannot be made passable. */
function build(input: ChuteInput, obstacles: readonly Obstacle[], funnelStart: number, length: number,
  innerSeed: number): Candidate | null {
  const start = funnelStart + CHUTE_FUNNEL_SEGMENTS;
  const end = start + length;
  let demoted = 0;
  let removed = 0;
  const kept: Obstacle[] = [];
  for (const o of obstacles) {
    if (o.segIndex >= funnelStart && o.segIndex < end) { removed++; continue; }
    // An outer-lane mogul close enough before the first wall tree would carry its rider straight into it.
    if (o.kind === 'mogul' && (o.lane === FIRST_OUTER || o.lane === LAST_OUTER) &&
        o.segIndex >= funnelStart - CHUTE_MOGUL_MARGIN_SEGMENTS && o.segIndex < funnelStart) {
      kept.push({ ...o, kind: 'rock' });
      demoted++;
      continue;
    }
    kept.push(o);
  }
  const walls: Obstacle[] = [];
  for (let seg = start; seg < end; seg += CHUTE_WALL_SPACING) {
    for (const lane of [FIRST_OUTER, LAST_OUTER]) walls.push({ kind: 'tree', lane, segIndex: seg, z: segmentCentreZ(seg), wall: true });
  }
  const after = kept.filter((o) => o.segIndex >= end);
  const inner = innerRows(start, length, after, mulberry32((innerSeed ^ Math.imul(funnelStart + 1, 0x9e3779b1)) >>> 0));
  let field = [...kept, ...walls, ...inner].sort((a, b) => a.segIndex - b.segIndex);
  // The walls are judged with the chute marked on the segments: the funnel must bring any lane to an inner
  // one by the first wall row, the outer lanes stay closed through the stretch (`advanceLanes`), and the
  // inner rows must leave a reachable clear lane. Marked only for the duration of the check.
  mark(input.segments, funnelStart, start, end, true);
  try {
    const check = (from?: { lanes: readonly number[]; seg: number }) =>
      firstUnpassableRow(field, input.crestApexes, input.placeableStart, input.segments, from);
    if (check()) return null;
    // The exit: a rider can leave the walls in ANY inner lane (the last inner rock may have pushed it into one), and
    // from each of them the rows after must still be passable. A row that is not (it blocks the lane the rider is
    // in, with too little road to change) is removed whole.
    let thinned = 0;
    const exitFailure = () => {
      for (const lane of CHUTE_INNER_LANES) {
        const failure = check({ lanes: [lane], seg: end - 1 });
        if (failure) return failure;
      }
      return null;
    };
    for (let failure = exitFailure(); failure; failure = exitFailure()) {
      if (thinned >= 6) return null;
      field = field.filter((o) => o.segIndex !== failure.seg);
      thinned++;
    }
    if (check()) return null;
    return { funnelStart, field, chute: { funnelStart, start, length, walls: walls.length, inner: inner.length, removed, demoted, thinned } };
  } finally {
    mark(input.segments, funnelStart, start, end, false);
  }
}

/**
 * Chute pass (#39, part 3). Places ONE tree chute per course, inside one of the two
 * forest sections (never the warm-up). Runs AFTER `placeObstacles`, the ice and the
 * powder passes and draws only from `stream` (`chuteStream`), so geometry, sections,
 * rival parameters and every obstacle outside the chute are those of a course without it.
 *
 * Layout, in segments: a funnel of `CHUTE_FUNNEL_SEGMENTS` (`chuteFunnel`, obstacle-free),
 * then `CHUTE_MIN_SEGMENTS`..`CHUTE_MAX_SEGMENTS` walled ones (`chute`) with a real `tree` in
 * lanes 0 and 4 on every `CHUTE_WALL_SPACING`-th, and in between a few rocks and moguls in
 * lanes 1-3, never trees, never all three lanes in a row. The walls are their own pass: they
 * are not rows of the gate/slalom model, so its row-gap rules do not apply to them.
 *
 * Everything in the funnel and walled stretch is replaced. Nothing else moves, except:
 *  - an outer-lane mogul in the `CHUTE_MOGUL_MARGIN_SEGMENTS` before the funnel is demoted to a
 *    rock (a trick jump flies 18 segments straight, into the wall), and
 *  - if a row just after the walls is impassable for a rider leaving in some particular inner lane, it is removed.
 * Candidates are tried from a seeded start; the first with neither change is used, otherwise the
 * one with the fewest. If nothing fits in either forest section the course has no chute.
 */
export function placeChute(input: ChuteInput, obstacles: Obstacle[], stream: Prng): { obstacles: Obstacle[]; chutes: Chute[] } {
  const wanted = randInt(stream, CHUTE_MIN_SEGMENTS, CHUTE_MAX_SEGMENTS);
  const sectionRoll = stream();
  const startRoll = stream();
  const innerSeed = Math.floor(stream() * 0x100000000) >>> 0;
  const forests = input.sections.map((section, index) => ({ section, index }))
    .filter(({ section }) => section.theme === 'forest' && section.setpiece !== 'warmup');
  if (forests.length === 0) return { obstacles, chutes: [] };
  const first = Math.floor(sectionRoll * forests.length);
  for (let k = 0; k < forests.length; k++) {
    const { section, index } = forests[(first + k) % forests.length];
    // A shorter chute is used only if the drawn length fits nowhere.
    for (let length = wanted; length >= CHUTE_MIN_SEGMENTS; length--) {
      const starts: number[] = [];
      for (const [begin, end] of openRuns(input.segments, section)) {
        for (let funnelStart = begin; funnelStart + CHUTE_FUNNEL_SEGMENTS + length <= end; funnelStart++) starts.push(funnelStart);
      }
      if (starts.length === 0) continue;
      const offset = Math.floor(startRoll * starts.length);
      let best: Candidate | null = null;
      let bestCost = Infinity;
      for (let j = 0; j < starts.length && bestCost > 0; j++) {
        const candidate = build(input, obstacles, starts[(offset + j) % starts.length], length, innerSeed);
        if (!candidate) continue;
        const cost = candidate.chute.demoted + candidate.chute.thinned;
        if (cost < bestCost) { best = candidate; bestCost = cost; }
      }
      if (!best) continue;
      mark(input.segments, best.funnelStart, best.chute.start, chuteEnd(best.chute), true);
      return { obstacles: best.field, chutes: [{ sectionIndex: index, ...best.chute }] };
    }
  }
  return { obstacles, chutes: [] };
}
