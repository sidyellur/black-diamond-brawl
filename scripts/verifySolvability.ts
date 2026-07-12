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
 *   4. same-seed determinism — generating twice yields a byte-identical field.
 *
 * Exits non-zero with a clear message if ANY seed fails.
 */
import {
  BLIND_LANDING_SEGMENTS,
  JUMP_REACH_EXTENDED,
  LANE_CHANGE_SEGMENTS,
  LANES
} from '../src/config';
import { Obstacle } from '../src/entities/obstacle';
import { generateTrack } from '../src/track/generator';

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

/** Group placed obstacles into rows keyed by their segment index. */
function groupRows(obstacles: Obstacle[]): Row[] {
  const bySeg = new Map<number, Row>();
  for (const o of obstacles) {
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
}

function verifySeed(seed: number): SeedResult {
  const track = generateTrack(seed);
  const rows = groupRows(track.obstacles);

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

  // Reachability walk from the true initial state: player at CENTER lane,
  // segment 0, with the warm-up straight before the first row.
  let reachable = new Set<number>([CENTER_LANE]);
  let prevSeg = 0;
  let minReachable = LANE_COUNT;

  for (const row of rows) {
    if (row.blocked.size >= LANE_COUNT) {
      return { ok: false, reason: `row at seg ${row.seg} blocks ALL ${LANE_COUNT} lanes`, minReachable, rowCount: rows.length };
    }

    const gap = row.seg - prevSeg;
    const lockedInGap = countLocked(prevSeg, row.seg);
    const steerable = Math.max(0, gap - lockedInGap);
    const maxShift = Math.floor(steerable / LANE_CHANGE_SEGMENTS);
    const arrival = dilate(reachable, maxShift);

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
    reachable = clearReachable;
    prevSeg = row.seg;
  }

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

  return { ok: true, minReachable, rowCount: rows.length };
}

function main(): void {
  let failures = 0;
  let globalMinReachable = LANE_COUNT;
  let totalRows = 0;
  let firstFailure: { seed: number; reason: string } | null = null;

  for (let seed = SEED_START; seed < SEED_START + SEED_COUNT; seed++) {
    const r = verifySeed(seed);
    totalRows += r.rowCount;
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
      `  total obstacle rows checked: ${totalRows}\n` +
      `  global minimum reachable clear-lane count: ${globalMinReachable} (1 = guarantee is binding, not trivially satisfied)\n` +
      `  checks per seed: >=1 clear lane/row, reachable clear lane/row (crest-lock aware), crest blind zones clear, mogul jump-reach tree-free, same-seed determinism`
  );
}

main();
