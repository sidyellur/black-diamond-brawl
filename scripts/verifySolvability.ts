/**
 * Solvability verifier (Task 6 safety guarantee — re-runnable via
 * `npm run verify:solvability`).
 *
 * This is an INDEPENDENT check: it never calls the placement DP that produced
 * the obstacles. It takes the actual placed obstacle field for a seed, groups
 * it into rows, and re-derives — from scratch — what lanes a player could
 * reach, walking the rows in order and simulating steering, INCLUDING the crest
 * steering-lock (crossing a jumpable crest apex auto-launches a
 * ~JUMP_REACH_EXTENDED-segment airborne span during which lanes cannot change).
 *
 * For each seed it asserts:
 *   1. every obstacle row leaves ≥1 clear lane;
 *   2. every row has a clear lane REACHABLE from the previous reachable set,
 *      accounting for the crest lock (the constructive safety guarantee);
 *   3. no obstacle of any kind in a crest blind-landing window, and no tree in
 *      a mogul's downstream jump-reach window (same lane);
 *   4. same-seed determinism — generating twice yields a byte-identical field;
 *   5. ice (#39): a lane change across ice costs ICE_LANE_CHANGE_SEGMENTS, read
 *      from the one shared helper `gapLaneChangeSegments` (the generator uses the
 *      same one, so they cannot disagree; a gap partly on ice is charged the ice
 *      cost throughout), and no tree stands on ice or within ICE_TREE_FREE_SEGMENTS
 *      segments after it.
 *
 *   6. tree chute (#39, part 3): the walls are not ordinary rows. Inside the walled stretch
 *      reachability is computed over lanes 1-3 only; the funnel must let a rider who arrives
 *      in lane 0 or 4 reach lane 1 or 3 before the first wall tree (checked in segments AND
 *      in time at boost speed); the rows after the chute must be passable from ANY inner
 *      lane; the funnel holds no obstacle, the walls are trees in lanes 0 and 4 on every
 *      second segment and nothing else stands in them, the inner rows are rocks and moguls
 *      that always leave an inner lane clear, and no pickup sits in a wall lane or in the
 *      last of the funnel.
 *
 * Exits non-zero with a clear message if ANY seed fails.
 */
import {
  BLIND_LANDING_SEGMENTS,
  BOOST_SPEED_FACTOR,
  CHUTE_FUNNEL_SEGMENTS,
  CHUTE_MAX_SEGMENTS,
  JUMP_AIRTIME_EXTENDED_MS,
  CHUTE_MIN_SEGMENTS,
  CHUTE_PICKUP_BUFFER_SEGMENTS,
  CHUTE_WALL_SPACING,
  LANE_TWEEN_MS,
  MAX_SPEED,
  SEGMENT_LENGTH,
  JUMP_REACH_EXTENDED,
  ICE_TREE_FREE_SEGMENTS,
  ROCK_LOCK_SEGMENTS,
  LANE_CHANGE_SEGMENTS,
  LANES
} from '../src/config';
import { Obstacle } from '../src/entities/obstacle';
import { generateTrack } from '../src/track/generator';
import { gapLaneChangeSegments } from '../src/track/surface';
import type { Segment } from '../src/track/segment';

const LANE_COUNT = LANES.length;
const CENTER_LANE = Math.floor(LANE_COUNT / 2);

const SEED_START = 1;
const SEED_COUNT = 1000;

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

interface Row {
  seg: number;
  blocked: Set<number>;
  obstacles: Obstacle[];
}

/** The walled stretches of a course, found from the segment flags alone (never from the generator's list). */
function chuteRuns(segments: readonly Segment[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  for (let s = 0; s < segments.length; s++) {
    if (!segments[s].chute) continue;
    if (runs.length && runs[runs.length - 1].end === s) runs[runs.length - 1].end = s + 1;
    else runs.push({ start: s, end: s + 1 });
  }
  return runs;
}

/** Group placed obstacles into rows keyed by their segment index. A chute's wall trees are not rows: only
 *  the first wall row is kept (the funnel must have brought the rider inward by it); the outer lanes are
 *  closed for the rest of the stretch by `arrive` below. */
function groupRows(obstacles: Obstacle[], segments: readonly Segment[]): Row[] {
  const bySeg = new Map<number, Row>();
  for (const o of obstacles) {
    if (o.kind === 'tree' && segments[o.segIndex]?.chute && segments[o.segIndex - 1]?.chute && (o.lane === 0 || o.lane === LANE_COUNT - 1)) continue;
    let row = bySeg.get(o.segIndex);
    if (!row) {
      row = { seg: o.segIndex, blocked: new Set(), obstacles: [] };
      bySeg.set(o.segIndex, row);
    }
    row.blocked.add(o.lane);
    row.obstacles.push(o);
  }
  return [...bySeg.values()].sort((a, b) => a.seg - b.seg);
}

interface SeedResult {
  ok: boolean;
  reason?: string;
  minReachable: number;
  rowCount: number;
  powderEntryRows?: number;
  /** Rows whose lane-change gap touches ice and so were walked at the ice cost. */
  iceCostRows?: number;
  /** Of those, rows where the ice cost left a smaller reachable set than the ordinary cost would have. */
  iceBindingRows?: number;
  iceSegments?: number;
  chute?: ChuteStats;
}

interface ChuteStats {
  /** Inner rows (rock/mogul rows inside the walls) walked. */
  innerRows: number;
  /** Wall trees found. */
  walls: number;
  /** Funnels checked. */
  funnels: number;
  /** Exits checked: the rows after the walls walked from every inner lane. */
  exits: number;
  /** Worst-case segments of road a rider arriving in an outer lane has to change lanes before the first wall. */
  funnelSteerable: number;
  /** Time that road takes at boost speed, and the lane change it has to fit. */
  funnelBoostMs: number;
}

/**
 * The chute rules, derived from the segments and the obstacle list alone (never from `track.chute`, which is
 * only cross-checked). Returns stats, or the reason for the first violation.
 */
function verifyChute(track: ReturnType<typeof generateTrack>, rows: Row[], runs: { start: number; end: number }[],
  arrive: (from: Set<number>, a: number, seg: number) => Set<number>,
  countLocked: (lo: number, hi: number) => number): ChuteStats | string {
  if (runs.length !== 1) return `${runs.length} walled stretches (exactly one per course)`;
  const { start, end } = runs[0];
  const length = end - start;
  if (length < CHUTE_MIN_SEGMENTS || length > CHUTE_MAX_SEGMENTS) return `chute length ${length}`;
  if (track.chute.length !== 1 || track.chute[0].start !== start || track.chute[0].length !== length) return 'chute list disagrees with the segment flags';
  const section = track.sections[track.segments[start].sectionIndex!];
  if (section.theme !== 'forest' || section.setpiece === 'warmup' || track.segments[end - 1].sectionIndex !== track.segments[start].sectionIndex) {
    return 'chute is not wholly inside one forest section';
  }
  const funnelStart = start - CHUTE_FUNNEL_SEGMENTS;
  for (let s = funnelStart; s < end; s++) {
    if (track.segments[s].safeZone) return `chute segment ${s} is a ${track.segments[s].safeZone} safe zone`;
    if (!!track.segments[s].chuteFunnel !== (s < start) || !!track.segments[s].chute !== (s >= start)) return `bad chute flags at segment ${s}`;
  }
  if (track.segments.filter((x) => x.chuteFunnel).length !== CHUTE_FUNNEL_SEGMENTS) return 'funnel is not exactly CHUTE_FUNNEL_SEGMENTS long';
  // Funnel: no obstacle of any kind.
  const funnelObstacle = track.obstacles.find((o) => o.segIndex >= funnelStart && o.segIndex < start);
  if (funnelObstacle) return `${funnelObstacle.kind} in the funnel at segment ${funnelObstacle.segIndex}`;
  // Walls: a tree in lane 0 and lane 4 on every CHUTE_WALL_SPACING-th segment, and no other tree or outer-lane obstacle.
  const inside = track.obstacles.filter((o) => o.segIndex >= start && o.segIndex < end);
  const walls = inside.filter((o) => o.kind === 'tree');
  for (let s = start; s < end; s++) {
    const wanted = (s - start) % CHUTE_WALL_SPACING === 0;
    for (const lane of [0, LANE_COUNT - 1]) {
      const here = walls.filter((o) => o.segIndex === s && o.lane === lane);
      if (here.length !== (wanted ? 1 : 0)) return `wall tree ${wanted ? 'missing' : 'unexpected'} at segment ${s} lane ${lane}`;
    }
  }
  if (walls.some((o) => o.lane !== 0 && o.lane !== LANE_COUNT - 1)) return 'tree in an inner lane of the chute';
  if (walls.some((o) => !o.wall)) return 'wall tree not flagged wall';
  if (track.obstacles.some((o) => o.wall && !walls.includes(o))) return 'wall flag outside the walls';
  const innerObstacles = inside.filter((o) => o.kind !== 'tree');
  if (innerObstacles.some((o) => o.lane === 0 || o.lane === LANE_COUNT - 1)) return 'rock or mogul in a wall lane';
  const innerRowSegs = new Set(innerObstacles.map((o) => o.segIndex));
  for (const seg of innerRowSegs) {
    const blocked = new Set(innerObstacles.filter((o) => o.segIndex === seg).map((o) => o.lane));
    if (blocked.size >= LANE_COUNT - 2) return `inner row at ${seg} blocks every inner lane`;
  }
  // Mogul rule at the speed the fastest rider really flies: an extended jump lasts JUMP_AIRTIME_EXTENDED_MS whatever the
  // speed, so at boost speed it carries a rider further than the JUMP_REACH_EXTENDED = 18 segments quoted at MAX_SPEED
  // (checked for every tree already, above). A wall tree is hit mid-air, so no mogul may fly into one: not in a wall
  // lane before the funnel, and not an inner one into the trees after the chute.
  const boostedFlight = Math.ceil(((JUMP_AIRTIME_EXTENDED_MS / 1000) * MAX_SPEED * BOOST_SPEED_FACTOR + SEGMENT_LENGTH) / SEGMENT_LENGTH) - 1;
  for (const mogul of track.obstacles.filter((o) => o.kind === 'mogul' && o.segIndex < end && o.segIndex + boostedFlight >= start)) {
    const hit = track.obstacles.find((o) => o.kind === 'tree' && o.lane === mogul.lane && o.segIndex > mogul.segIndex && o.segIndex <= mogul.segIndex + boostedFlight);
    if (hit) return `mogul at ${mogul.segIndex} lane ${mogul.lane} flies ${boostedFlight} segments at boost speed into the tree at ${hit.segIndex}`;
  }
  // Funnel reach: a rider arriving in lane 0 or 4 reaches lane 1 or 3 before the first wall tree. In
  // segments with the ordinary cost, and in time: at BOOST speed the funnel is the shortest it ever is in
  // time, and the lane change (LANE_TWEEN_MS) has to finish inside it with the cost's margin to spare.
  const funnelSteerable = start - funnelStart;
  const cost = gapLaneChangeSegments(track.segments, funnelStart, start);
  if (Math.floor(funnelSteerable / cost) < 1) return 'funnel too short for one lane change';
  for (const from of [0, LANE_COUNT - 1]) {
    const reached = arrive(new Set([from]), funnelStart - 1, start);
    if (!reached.has(1) && !reached.has(LANE_COUNT - 2)) return `a rider in lane ${from} cannot reach lane 1 or 3 before the first wall tree`;
  }
  const funnelBoostMs = (funnelSteerable * SEGMENT_LENGTH) / (MAX_SPEED * BOOST_SPEED_FACTOR) * 1000;
  if (funnelBoostMs < 2 * LANE_TWEEN_MS) return `funnel lasts only ${funnelBoostMs.toFixed(0)} ms at boost speed`;
  // Exit: a rider can leave the walls in ANY inner lane (the last inner rock may have pushed it into one), and from each
  // of them every row after the walls must still have a reachable clear lane.
  const exitRows = rows.filter((r) => r.seg >= end);
  for (const lane of [1, 2, 3]) {
    let reachable = new Set<number>([lane]);
    let prev = end - 1;
    for (const row of exitRows) {
      const arrival = arrive(reachable, prev, row.seg);
      reachable = new Set([...arrival].filter((l) => !row.blocked.has(l)));
      if (reachable.size === 0) return `row at ${row.seg} after the chute is not passable for a rider leaving in lane ${lane}`;
      prev = row.seg;
      if (row.seg > end + 80) break; // reachability has long since widened back to the whole road
    }
  }
  // Pickups: none in a wall lane, inside the walls or in the last CHUTE_PICKUP_BUFFER_SEGMENTS of the funnel.
  for (const pickup of track.pickups) {
    if ((pickup.lane === 0 || pickup.lane === LANE_COUNT - 1) && pickup.segIndex > start - CHUTE_PICKUP_BUFFER_SEGMENTS - 1 && pickup.segIndex < end) {
      return `pickup in wall lane ${pickup.lane} at segment ${pickup.segIndex}`;
    }
  }
  void countLocked;
  return { innerRows: innerRowSegs.size, walls: walls.length, funnels: 1, exits: 3, funnelSteerable, funnelBoostMs };
}

function verifySeed(seed: number): SeedResult {
  const track = generateTrack(seed);
  const rows = groupRows(track.obstacles, track.segments);

  // Determinism: regenerate and compare byte-for-byte.
  const again = generateTrack(seed);
  if (JSON.stringify(again.obstacles) !== JSON.stringify(track.obstacles)) {
    return { ok: false, reason: 'non-deterministic: same seed produced a different obstacle field', minReachable: 0, rowCount: rows.length };
  }

  // Independently re-derive the crest steering-lock spans from geometry, NOT
  // from any placement state: [apex, apex + JUMP_REACH_EXTENDED] per crest.
  const maxSeg = rows.length ? rows[rows.length - 1].seg + 1 : 0;
  const locked = new Array<boolean>(maxSeg + JUMP_REACH_EXTENDED + 1).fill(false);
  for (const apex of track.crestApexes) {
    for (let s = Math.max(0, apex); s <= apex + JUMP_REACH_EXTENDED; s++) {
      locked[s] = true;
    }
  }
  const countLocked = (loExclusive: number, hiInclusive: number): number => {
    let n = 0;
    for (let s = loExclusive + 1; s <= hiInclusive; s++) {
      if (locked[s]) {
        n++;
      }
    }
    return n;
  };

  // Powder (#39) needs no change to the lane-change model: it only slows riders. Its one rule is that the
  // entry moguls are ordinary placed obstacles. This verifier never reads the powder list to skip them: it
  // finds them in the obstacle rows it walks below, and here only confirms they are really in that field.
  let powderEntryRows = 0;
  for (const field of track.powder) {
    const row = rows.find((r) => r.seg === field.start);
    const moguls = row?.obstacles.filter((o) => o.kind === 'mogul').map((o) => o.lane).sort() ?? [];
    if (!row || moguls.length < 2 || JSON.stringify(moguls) !== JSON.stringify([...field.moguls].sort())) {
      return { ok: false, reason: `powder entry at seg ${field.start} is not a row of >=2 placed moguls in the obstacle field`, minReachable: 0, rowCount: rows.length };
    }
    powderEntryRows++;
  }

  // Lane changes over the steerable segments in (a, b] (crest locks excluded), at the cost for that stretch.
  const shiftBetween = (a: number, b: number): number =>
    Math.floor(Math.max(0, b - a - countLocked(a, b)) / gapLaneChangeSegments(track.segments, a, b));
  const runs = chuteRuns(track.segments);
  const insideChute = (seg: number): boolean => runs.some((r) => seg >= r.start && seg < r.end);
  const innerOnly = (lanes: Set<number>): Set<number> => new Set([...lanes].filter((l) => l > 0 && l < LANE_COUNT - 1));
  /** Lanes reachable on arrival at `seg` from `from` at `a`. A chute closes lanes 0 and 4 from its first wall
   *  segment to its last: the rider must be inside lanes 1-3 by the first wall, can only dilate within them
   *  until the last wall, and wins the outer lanes back only with the road that is left after it. */
  const arrive = (from: Set<number>, a: number, seg: number): Set<number> => {
    let lanes = from;
    let at = a;
    for (const r of runs) {
      if (r.start > a && r.start <= seg) { lanes = innerOnly(dilate(lanes, shiftBetween(at, r.start))); at = r.start; }
      if (r.end - 1 >= at && r.end <= seg) { lanes = innerOnly(dilate(lanes, shiftBetween(at, r.end - 1))); at = r.end - 1; }
    }
    lanes = dilate(lanes, shiftBetween(at, seg));
    return insideChute(seg) ? innerOnly(lanes) : lanes;
  };

  // Reachability walk from the true initial state: player at CENTER lane,
  // segment 0, with the warm-up straight before the first row.
  let reachable = new Set<number>([CENTER_LANE]);
  // The same walk at the ordinary cost, only to show where the ice cost bites.
  let ordinaryReachable = new Set<number>([CENTER_LANE]);
  let prevSeg = 0;
  let minReachable = LANE_COUNT;
  let iceCostRows = 0;
  let iceBindingRows = 0;

  for (const row of rows) {
    if (row.blocked.size >= LANE_COUNT) {
      return { ok: false, reason: `row at seg ${row.seg} blocks ALL ${LANE_COUNT} lanes`, minReachable, rowCount: rows.length };
    }

    const gap = row.seg - prevSeg;
    const lockedInGap = countLocked(prevSeg, row.seg);
    const steerable = Math.max(0, gap - lockedInGap);
    // A rider can start a lane change anywhere in [prevSeg, row.seg); any ice there charges the whole gap
    // the ice cost. The helper is the single definition shared with placement.
    const cost = gapLaneChangeSegments(track.segments, prevSeg, row.seg);
    const maxShift = Math.floor(steerable / cost);
    const arrival = arrive(reachable, prevSeg, row.seg);
    const ordinaryArrival = dilate(ordinaryReachable, Math.floor(steerable / LANE_CHANGE_SEGMENTS));
    ordinaryReachable = new Set([...ordinaryArrival].filter((l) => !row.blocked.has(l)));
    if (cost !== LANE_CHANGE_SEGMENTS) iceCostRows++;

    const clearReachable = new Set<number>();
    for (let l = 0; l < LANE_COUNT; l++) {
      if (!row.blocked.has(l) && arrival.has(l)) {
        clearReachable.add(l);
      }
    }

    if (clearReachable.size === 0) {
      return {
        ok: false,
        reason: `row at seg ${row.seg} has NO reachable clear lane (blocked={${[...row.blocked].join(',')}}, reachable-before={${[...reachable].join(',')}}, gap=${gap}, lockedInGap=${lockedInGap}, maxShift=${maxShift})`,
        minReachable,
        rowCount: rows.length
      };
    }

    minReachable = Math.min(minReachable, clearReachable.size);
    if (cost !== LANE_CHANGE_SEGMENTS && clearReachable.size < ordinaryReachable.size) iceBindingRows++;
    reachable = clearReachable;
    prevSeg = row.seg;
  }

  // Ice: found from the segments themselves, not from the generator's list. No tree on it or in the margin after it.
  let iceSegments = 0;
  for (let index = 0; index < track.segments.length; index++) {
    if (track.segments[index].surface !== 'ice') continue;
    iceSegments++;
    const last = track.segments[index + 1]?.surface !== 'ice';
    for (const o of track.obstacles) {
      if (o.kind === 'tree' && (o.segIndex === index || (last && o.segIndex > index && o.segIndex <= index + ICE_TREE_FREE_SEGMENTS))) {
        return { ok: false, reason: `tree at seg ${o.segIndex} lane ${o.lane} on or within ${ICE_TREE_FREE_SEGMENTS} segments after ice (seg ${index})`, minReachable, rowCount: rows.length };
      }
    }
  }

  // ---- tree chute (#39, part 3) -----------------------------------------------------------------
  const chute = verifyChute(track, rows, runs, arrive, countLocked);
  if (typeof chute === 'string') return { ok: false, reason: chute, minReachable, rowCount: rows.length };

  // Crest blind-landing windows: no obstacle of ANY kind in [apex, apex+BLIND].
  for (const apex of track.crestApexes) {
    for (const o of track.obstacles) {
      if (o.segIndex >= apex && o.segIndex <= apex + BLIND_LANDING_SEGMENTS) {
        return { ok: false, reason: `obstacle (${o.kind}) at seg ${o.segIndex} lane ${o.lane} inside crest blind zone [${apex}, ${apex + BLIND_LANDING_SEGMENTS}]`, minReachable, rowCount: rows.length };
      }
    }
  }

  // Mogul jump-reach windows: no tree in the same lane within
  // (mogulSeg, mogulSeg+JUMP_REACH_EXTENDED].
  const trees = track.obstacles.filter((o) => o.kind === 'tree');
  for (const m of track.obstacles) {
    if (m.kind !== 'mogul') {
      continue;
    }
    for (const tree of trees) {
      if (tree.lane === m.lane && tree.segIndex > m.segIndex && tree.segIndex <= m.segIndex + JUMP_REACH_EXTENDED) {
        return { ok: false, reason: `tree at seg ${tree.segIndex} lane ${tree.lane} inside mogul (seg ${m.segIndex}) jump-reach window`, minReachable, rowCount: rows.length };
      }
    }
  }

  // Rock no-steer windows: no tree in the same lane within
  // (rockSeg, rockSeg+ROCK_LOCK_SEGMENTS]. A rock hit locks steering for ~1s,
  // and the rider is by definition in the rock's own lane — so a tree in that
  // lane inside the window is an unavoidable run-ending death, with nothing
  // the player can do from the moment the rock lands. Same shape of guarantee
  // as the mogul jump-reach check above.
  for (const rock of track.obstacles) {
    if (rock.kind !== 'rock') {
      continue;
    }
    for (const tree of trees) {
      if (tree.lane === rock.lane && tree.segIndex > rock.segIndex && tree.segIndex <= rock.segIndex + ROCK_LOCK_SEGMENTS) {
        return { ok: false, reason: `tree at seg ${tree.segIndex} lane ${tree.lane} inside rock (seg ${rock.segIndex}) no-steer window`, minReachable, rowCount: rows.length };
      }
    }
  }

  return { ok: true, minReachable, rowCount: rows.length, powderEntryRows, iceCostRows, iceBindingRows, iceSegments, chute };
}

function main(): void {
  let failures = 0;
  let globalMinReachable = LANE_COUNT;
  let totalRows = 0;
  let totalEntryRows = 0;
  let totalIceCostRows = 0;
  let totalIceBinding = 0;
  let totalIceSegments = 0;
  const chuteTotals = { innerRows: 0, walls: 0, funnels: 0, exits: 0, minFunnelSteerable: Infinity, minFunnelBoostMs: Infinity };
  let firstFailure: { seed: number; reason: string } | null = null;

  for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const r = verifySeed(seed);
    totalRows += r.rowCount;
    totalEntryRows += r.powderEntryRows ?? 0;
    totalIceCostRows += r.iceCostRows ?? 0;
    totalIceBinding += r.iceBindingRows ?? 0;
    totalIceSegments += r.iceSegments ?? 0;
    if (r.chute) {
      chuteTotals.innerRows += r.chute.innerRows; chuteTotals.walls += r.chute.walls;
      chuteTotals.funnels += r.chute.funnels; chuteTotals.exits += r.chute.exits;
      chuteTotals.minFunnelSteerable = Math.min(chuteTotals.minFunnelSteerable, r.chute.funnelSteerable);
      chuteTotals.minFunnelBoostMs = Math.min(chuteTotals.minFunnelBoostMs, r.chute.funnelBoostMs);
    }
    globalMinReachable = Math.min(globalMinReachable, r.minReachable);
    if (!r.ok) {
      failures++;
      if (!firstFailure) {
        firstFailure = { seed, reason: r.reason ?? 'unknown' };
      }
      // eslint-disable-next-line no-console
      console.error(`FAIL seed ${seed}: ${r.reason}`);
    }
  }

  const lastSeed = SEED_START + SEED_COUNT - 1;
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`\nSOLVABILITY VERIFICATION FAILED: ${failures}/${SEED_COUNT} seeds failed (seeds ${SEED_START}..${lastSeed}).`);
    if (firstFailure) {
      // eslint-disable-next-line no-console
      console.error(`First failure: seed ${firstFailure.seed} — ${firstFailure.reason}`);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `SOLVABILITY OK: ${SEED_COUNT}/${SEED_COUNT} seeds passed (seeds ${SEED_START}..${lastSeed}).\n` +
      `  total obstacle rows checked: ${totalRows} (including ${totalEntryRows} powder entry-mogul rows, walked like any other row)\n` +
      `  rows walked at the ICE lane-change cost (gap touches ice): ${totalIceCostRows} over ${totalIceSegments} ice segments; ice cost left a smaller reachable set than the ordinary cost on ${totalIceBinding} of them\n` +
      `  tree chutes: ${chuteTotals.funnels} funnels, ${chuteTotals.walls} wall trees and ${chuteTotals.innerRows} inner rows (lanes 1-3 only) walked, ${chuteTotals.exits} exit walks (one per inner lane to leave in); ` +
      `shortest funnel ${chuteTotals.minFunnelSteerable} segments = ${chuteTotals.minFunnelBoostMs.toFixed(0)} ms at boost speed (a lane change takes ${LANE_TWEEN_MS} ms)\n` +
      `  global minimum reachable clear-lane count: ${globalMinReachable} (1 = guarantee is binding, not trivially satisfied)\n` +
      `  checks per seed: >=1 clear lane/row, reachable clear lane/row (crest-lock, ice-cost and chute aware), chute layout/funnel/exit/pickups, tree-free on and after ice, crest blind zones clear, mogul jump-reach tree-free, rock no-steer tree-free, same-seed determinism`
  );
}

main();
