/**
 * The tree chute (#39, part 3). Headless model checks through the real Player / AIRider /
 * CollisionSystem / CombatSystem / ScoreTracker / BoostMeter and the real generator.
 *
 *   1. generation: the chute replaces what stood in its own stretch and nothing else
 *   2. funnel: a rider arriving in an outer lane gets inward in time, at boost speed, with reaction time to spare
 *   3. near-miss farming: wall trees pay nothing; what a clean pass is worth before and after
 *   4. pickups: none in a wall lane or in the last of the funnel
 *   5. rivals: wall crashes per chute pass and eliminations, over 400 seeds x 4 rivals
 *   6. combat: rival attacks cannot knock the player into the wall; the player's shove can
 *   7. the player in the wall: steering inward at the first steerable moment always avoids the second strike
 *   8. rendering cost: obstacle sprites in view
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  BOOST_GAIN, BOOST_MAX, BOOST_SPEED_FACTOR, CHUTE_AWARENESS_SEGMENTS, CHUTE_FUNNEL_SEGMENTS, CHUTE_PICKUP_BUFFER_SEGMENTS,
  DRAW_DISTANCE, KNOCKOUT_WINDOW_MS, LANE_TWEEN_MS, LANES, MAX_SPEED, POINTS, SEGMENT_LENGTH, TREE_CLAMP_SEGMENTS
} from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { BoostMeter } from '../src/entities/boost';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';
import { cupRivalParams } from '../src/progression/cup';
import { chuteAhead, chuteEnd, chuteEntryCue, CHUTE_CUE, inChute, isChuteWall } from '../src/track/chute';
import { generateTrack, type GeneratedTrack } from '../src/track/generator';
import { surfaceAtZ } from '../src/track/surface';

const STEP = 1000 / 60;
let passed = 0;
function test(name: string, run: () => void): void {
  const started = performance.now();
  run();
  passed++;
  console.log(`  PASS ${name} (${Math.round(performance.now() - started)} ms)`);
}
const info = (text: string) => console.log(`    ${text}`);
const LAST = LANES.length - 1;
const seeds = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const SEEDS = seeds(400);
const courses = new Map<number, GeneratedTrack>();
const course = (seed: number): GeneratedTrack => {
  let c = courses.get(seed);
  if (!c) { c = generateTrack(seed); courses.set(seed, c); }
  return c;
};
const wallTrees = (t: GeneratedTrack) => t.obstacles.filter(isChuteWall);
const treeAt = (lane: number, z: number): Obstacle => ({ kind: 'tree', lane, z, segIndex: Math.floor(z / SEGMENT_LENGTH) });
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A player placed in `lane` at `z` going `speed`, settled there. */
function playerAt(lane: number, z: number, speed = MAX_SPEED): Player {
  const p = new Player();
  if (lane !== 2) p.applyKnockback(lane, 0);
  for (let i = 0; i < 30; i++) p.update(STEP);
  p.worldZ = z; p.speed = speed;
  return p;
}

console.log('\n=== tree chute ===');

// ---- 1. generation --------------------------------------------------------------------------
test('generation: the chute replaces its own stretch and changes nothing else (400 seeds, against the same course without it)', () => {
  const tally = { removed: 0, added: 0, walls: 0, inner: 0, demoted: 0, thinned: 0, noChute: 0, pickupSeeds: 0, pickupsMoved: 0, pickups: 0 };
  const strip = ({ chute: _c, chuteFunnel: _f, ...rest }: GeneratedTrack['segments'][number]) => rest;
  for (const seed of SEEDS) {
    const t = course(seed);
    const bare = generateTrack(seed, { chute: false });
    assert.equal(bare.chute.length, 0);
    assert.ok(!bare.segments.some((s) => s.chute || s.chuteFunnel) && !bare.obstacles.some((o) => o.wall));
    if (t.chute.length !== 1) { tally.noChute++; continue; }
    const c = t.chute[0];
    const span = (o: Obstacle) => o.segIndex >= c.funnelStart && o.segIndex < chuteEnd(c);
    assert.deepEqual(t.segments.map(strip), bare.segments.map(strip), `${seed}: geometry`);
    assert.deepEqual(t.sections, bare.sections, `${seed}: sections`);
    assert.deepEqual(t.aiRiders, bare.aiRiders, `${seed}: rival parameters`);
    assert.deepEqual(t.crestApexes, bare.crestApexes);
    assert.deepEqual(t.powder, bare.powder);
    assert.deepEqual(t.ice, bare.ice);
    // Outside the stretch the field is the bare course's, except what the generator reports it had to change.
    const outsideNow = t.obstacles.filter((o) => !span(o));
    const outsideBare = bare.obstacles.filter((o) => !span(o));
    if (c.demoted === 0 && c.thinned === 0) assert.deepEqual(outsideNow, outsideBare, `${seed}: an obstacle outside the chute moved`);
    else assert.equal(outsideNow.length, outsideBare.length - c.thinned);
    const insideBare = bare.obstacles.filter(span);
    assert.equal(insideBare.length, c.removed, `${seed}: removed count`);
    tally.removed += c.removed; tally.walls += c.walls; tally.inner += c.inner; tally.added += c.walls + c.inner;
    tally.demoted += c.demoted; tally.thinned += c.thinned;
    // Pickups: same count; only some move (the ones the new field or the wall-lane rule displaces).
    assert.equal(t.pickups.length, bare.pickups.length);
    const moved = t.pickups.filter((p, i) => p.lane !== bare.pickups[i].lane || p.segIndex !== bare.pickups[i].segIndex || p.kind !== bare.pickups[i].kind).length;
    if (moved) tally.pickupSeeds++;
    tally.pickupsMoved += moved; tally.pickups += t.pickups.length;
  }
  assert.equal(tally.noChute, 0, 'every seed hosts a chute');
  info(`${SEEDS.length} seeds: ${tally.noChute} without a chute; per course ${(tally.removed / SEEDS.length).toFixed(2)} obstacles removed, ` +
    `${(tally.added / SEEDS.length).toFixed(2)} added (${(tally.walls / SEEDS.length).toFixed(1)} wall trees + ${(tally.inner / SEEDS.length).toFixed(2)} inner rocks/moguls); ` +
    `${tally.demoted} outer-lane moguls demoted, ${tally.thinned} rows thinned after a chute`);
  info(`geometry, sections, ice, powder, crest list and rival parameters identical for all ${SEEDS.length}; pickups: ${tally.pickupsMoved} of ${tally.pickups} differ ` +
    `(${tally.pickupSeeds} courses), none added or lost`);
});

test('generation: the cue fires once on the way in, from the funnel, and the entry helpers agree with the flags', () => {
  const t = course(202);
  const c = t.chute[0];
  assert.equal(chuteEntryCue(false, true), CHUTE_CUE);
  assert.equal(chuteEntryCue(true, true), null);
  assert.equal(chuteEntryCue(true, false), null);
  assert.equal(CHUTE_CUE, 'CHUTE · THREE LANES');
  const z = (seg: number) => seg * SEGMENT_LENGTH + 1;
  assert.equal(inChute(t.segments, z(c.funnelStart - 1)), false);
  assert.equal(inChute(t.segments, z(c.funnelStart)), true);
  assert.equal(inChute(t.segments, z(chuteEnd(c) - 1)), true);
  assert.equal(inChute(t.segments, z(chuteEnd(c))), false);
  // Rivals are aware from the run-up before the first wall tree to the last one.
  assert.equal(chuteAhead(t.segments, z(c.start - CHUTE_AWARENESS_SEGMENTS - 1)), false);
  assert.equal(chuteAhead(t.segments, z(c.start - CHUTE_AWARENESS_SEGMENTS)), true);
  assert.equal(chuteAhead(t.segments, z(chuteEnd(c) - 1)), true);
  assert.equal(chuteAhead(t.segments, z(chuteEnd(c))), false);
  assert.equal(chuteAhead([], 0), false);
  assert.equal(chuteAhead(t.segments, NaN), false);
});

// ---- 2. funnel ------------------------------------------------------------------------------
test('funnel: a rider arriving in lane 0 or 4 at boost speed gets inward before the first wall tree, with time to spare', () => {
  const boostSpeed = MAX_SPEED * BOOST_SPEED_FACTOR;
  const funnelMs = CHUTE_FUNNEL_SEGMENTS * SEGMENT_LENGTH / boostSpeed * 1000;
  // Reaction time before the first steer press, scanned until the rider fails.
  const survives = (t: GeneratedTrack, lane: number, reactionMs: number): boolean => {
    const c = t.chute[0];
    const p = playerAt(lane, c.funnelStart * SEGMENT_LENGTH, boostSpeed);
    const cs = new CollisionSystem();
    const near = t.obstacles.filter((o) => o.segIndex >= c.funnelStart && o.segIndex < c.start + 8);
    for (let ms = 0; p.worldZ < (c.start + 6) * SEGMENT_LENGTH; ms += STEP) {
      if (ms >= reactionMs && p.leanDirection === 0 && p.laneIndex === lane) p.requestLaneShift(lane === 0 ? 1 : -1);
      p.update(STEP, true);
      p.speed = Math.max(p.speed, boostSpeed); // hold boost: the worst case for time
      cs.update(p, near);
      if (p.treeStrikes > 0) return false;
    }
    return true;
  };
  const probe = [0, 150, 250, 350, 400, 450];
  const ok = Object.fromEntries(probe.map((r) => [r, 0]));
  let runs = 0;
  for (const seed of SEEDS) {
    const t = course(seed);
    for (const lane of [0, LAST]) {
      runs++;
      for (const r of probe) if (survives(t, lane, r)) ok[r]++;
    }
  }
  assert.equal(ok[0], runs, 'steering the moment the funnel starts always clears');
  assert.equal(ok[250], runs, 'a quarter-second reaction at boost speed always clears');
  const worst = [...probe].reverse().find((r) => ok[r] === runs)!;
  info(`funnel = ${CHUTE_FUNNEL_SEGMENTS} segments = ${funnelMs.toFixed(0)} ms at boost speed (${boostSpeed} u/s); a lane change takes ${LANE_TWEEN_MS} ms; ` +
    `${runs} arrivals in lane 0/4: clear with ${probe.map((r) => `${r} ms -> ${ok[r]}/${runs}`).join(', ')}; every rider is safe up to ${worst} ms of reaction`);
});

// ---- 3. near-miss farming -------------------------------------------------------------------
/** Ride the walled stretch in `lane` (a mini-driver that only dodges inner rocks/moguls, staying in lanes 1-3), score it. */
function ride(t: GeneratedTrack, lane: number, payWalls: boolean, withInner: boolean) {
  const c = t.chute[0];
  const field = t.obstacles.filter((o) => o.segIndex >= c.funnelStart && o.segIndex < chuteEnd(c) && (withInner || o.wall))
    .map((o) => (payWalls ? { ...o, wall: undefined } : { ...o })) as Obstacle[];
  const p = playerAt(lane, (c.funnelStart - 6) * SEGMENT_LENGTH);
  const cs = new CollisionSystem();
  const combat = new CombatSystem(p, [], field);
  const score = new ScoreTracker(p, [], field, cs, combat);
  const boost = new BoostMeter();
  let near = 0;
  for (let time = STEP; p.worldZ < (chuteEnd(c) + 4) * SEGMENT_LENGTH; time += STEP) {
    if (p.leanDirection === 0 && !p.tumbling && !p.heavyCrashing) {
      const ahead = (l: number) => field.filter((o) => o.kind !== 'tree' && o.lane === l && o.z >= p.worldZ - 100).reduce((m, o) => Math.min(m, o.z - p.worldZ), Infinity);
      if (ahead(p.laneIndex) < 1400) {
        const options = [p.laneIndex - 1, p.laneIndex + 1].filter((l) => l >= 1 && l <= LAST - 1).sort((a, b) => ahead(b) - ahead(a));
        if (options.length && ahead(options[0]) > 1000) p.requestLaneShift(options[0] > p.laneIndex ? 1 : -1);
      }
    }
    p.update(STEP);
    cs.update(p, field);
    combat.update(STEP, time);
    score.update(STEP);
    const kinds = score.feedback.filter((e) => e.kind !== 'settled').map((e) => e.kind);
    near += score.feedback.filter((e) => e.kind === 'near').length;
    boost.addFeedback(kinds);
  }
  const result = score.finalize(true, 100_000, 1);
  return { near, points: result.nearMissPoints, event: score.runningScore, boost: boost.value, strikes: p.treeStrikes, wipedOut: p.wipedOut };
}

test('near misses: wall trees pay nothing, so riding between the walls is not worth points or boost', () => {
  const sample = seeds(40);
  const rows = { before: { points: 0, boost: 0, near: 0, event: 0 }, after: { points: 0, boost: 0, near: 0, event: 0 } };
  const wallsOnly = { before: { points: 0, boost: 0, near: 0 }, after: { points: 0, boost: 0, near: 0 } };
  let n = 0; let nWalls = 0; let maxAfterWalls = 0; let worstBefore = 0;
  for (const seed of sample) {
    const t = course(seed);
    for (const lane of [1, 3]) {
      // Walls alone (inner rows removed): the farming case.
      const b = ride(t, lane, true, false); const a = ride(t, lane, false, false);
      assert.equal(a.strikes + b.strikes, 0);
      wallsOnly.before.points += b.points; wallsOnly.before.boost += b.boost; wallsOnly.before.near += b.near;
      wallsOnly.after.points += a.points; wallsOnly.after.boost += a.boost; wallsOnly.after.near += a.near;
      maxAfterWalls = Math.max(maxAfterWalls, a.near);
      worstBefore = Math.max(worstBefore, b.points);
      nWalls++;
      // A real pass: the same walls plus the inner rocks and moguls the rider has to dodge.
      const rb = ride(t, lane, true, true); const ra = ride(t, lane, false, true);
      assert.equal(ra.wipedOut, false);
      rows.before.points += rb.points; rows.before.boost += rb.boost; rows.before.near += rb.near; rows.before.event += rb.event;
      rows.after.points += ra.points; rows.after.boost += ra.boost; rows.after.near += ra.near; rows.after.event += ra.event;
      n++;
    }
  }
  assert.equal(maxAfterWalls, 0, 'riding lane 1 or 3 past the walls alone earns not a single near miss');
  assert.ok(wallsOnly.before.near / nWalls >= 8, 'the farming case is real: an unexempted wall pays 8+ near misses a pass');
  // Boost: each near miss feeds BOOST_GAIN.NEAR_MISS to the meter (capped at BOOST_MAX).
  assert.equal(wallsOnly.after.boost, 0);
  const avg = (x: number) => (x / n).toFixed(0);
  const avgW = (x: number) => (x / nWalls).toFixed(0);
  info(`walls only (lane 1 or 3, ${nWalls} passes): BEFORE the rule ${(wallsOnly.before.near / nWalls).toFixed(1)} near misses = ${avgW(wallsOnly.before.points)} points, ` +
    `boost meter ${avgW(wallsOnly.before.boost)}/${BOOST_MAX} (worst pass ${worstBefore}); AFTER 0 near misses, 0 points, 0 boost`);
  info(`a real pass with its inner rocks and moguls dodged (${n} passes): BEFORE ${(rows.before.near / n).toFixed(1)} near misses, ${avg(rows.before.points)} points ` +
    `(${avg(rows.before.event)} with flow bonus), boost ${avg(rows.before.boost)}; AFTER ${(rows.after.near / n).toFixed(1)} near misses, ${avg(rows.after.points)} points ` +
    `(${avg(rows.after.event)} with flow bonus), boost ${avg(rows.after.boost)}`);
  assert.ok(rows.after.points < rows.before.points / 3, 'the rule removes most of what a pass paid');
  assert.equal(POINTS.NEAR_MISS, 100);
  assert.equal(BOOST_GAIN.NEAR_MISS, 8);
});

test('near misses: an inner rock or mogul passed in the next lane still pays, wall or no wall', () => {
  const p = playerAt(2, 10_000);
  const rock: Obstacle = { kind: 'rock', lane: 1, z: 10_400, segIndex: 52 };
  const wall: Obstacle = { kind: 'tree', lane: 1, z: 10_400, segIndex: 52, wall: true };
  const ordinary: Obstacle = { kind: 'tree', lane: 1, z: 10_400, segIndex: 52 };
  const pay = (o: Obstacle): number => {
    const q = playerAt(2, 10_000); const field = [o]; const cs = new CollisionSystem();
    const sc = new ScoreTracker(q, [], field, cs, new CombatSystem(q, [], field));
    for (let i = 0; i < 40; i++) { q.update(STEP); cs.update(q, field); sc.update(STEP); }
    return sc.finalize(true, 100_000, 1).nearMissPoints;
  };
  void p;
  assert.equal(pay(rock), POINTS.NEAR_MISS);
  assert.equal(pay(ordinary), POINTS.NEAR_MISS, 'an ordinary tree beside the player still pays');
  assert.equal(pay(wall), 0, 'a wall tree does not');
});

// ---- 4. pickups -----------------------------------------------------------------------------
test('pickups: none in a wall lane, inside the walls or in the last of the funnel (1,000 seeds)', () => {
  let near = 0; let bareInside = 0; let bareOuter = 0; let all = 0;
  for (const seed of seeds(1000)) {
    const t = course(seed);
    const c = t.chute[0];
    const from = c.start - CHUTE_PICKUP_BUFFER_SEGMENTS;
    for (const p of t.pickups) {
      all++;
      if (p.segIndex >= c.funnelStart - 20 && p.segIndex < chuteEnd(c) + 20) near++;
      if (p.segIndex >= from && p.segIndex < chuteEnd(c)) {
        assert.ok(p.lane >= 1 && p.lane <= LAST - 1, `seed ${seed}: pickup in lane ${p.lane} at ${p.segIndex}, the walls start at ${c.start}`);
      }
      // The pickup is on a clear lane too: not on a rock or mogul.
      assert.ok(!t.obstacles.some((o) => o.segIndex === p.segIndex && o.lane === p.lane), `seed ${seed}: pickup on an obstacle`);
    }
    // Without the rule: the same course with no chute, judged against the walls it would get. (This is why the rule exists.)
    const bare = generateTrack(seed, { chute: false });
    for (const p of bare.pickups) {
      if (p.segIndex >= from && p.segIndex < chuteEnd(c)) { bareInside++; if (p.lane === 0 || p.lane === LAST) bareOuter++; }
    }
  }
  info(`${all} pickups over 1,000 courses, ${near} within 20 segments of a chute, 0 in a wall lane or the last ${CHUTE_PICKUP_BUFFER_SEGMENTS} segments of a funnel; ` +
    `the course without a chute puts ${bareInside} pickups in that span, ${bareOuter} of them in lane 0 or 4`);
});

// ---- 5. rivals ------------------------------------------------------------------------------
interface RivalTally {
  entered: number; completed: number; wallCrashes: number; wallEliminations: number; wallThenElsewhere: number;
  otherEliminationsInChute: number; eliminationsElsewhere: number; outerAtEntry: number; stuckInWallLane: number; passes: number;
}
const newTally = (): RivalTally => ({ entered: 0, completed: 0, wallCrashes: 0, wallEliminations: 0, wallThenElsewhere: 0,
  otherEliminationsInChute: 0, eliminationsElsewhere: 0, outerAtEntry: 0, stuckInWallLane: 0, passes: 0 });

/** The obstacles a rider can possibly react to or hit this step, sorted by z: a window instead of the whole course. */
function windowed(sorted: Obstacle[], z: number): Obstacle[] {
  let lo = 0; let hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].z < z - 1500) lo = mid + 1; else hi = mid; }
  let end = lo;
  while (end < sorted.length && sorted[end].z <= z + 9000) end++;
  return sorted.slice(lo, end);
}

/** Four production rivals alone on a course, no player anywhere near: what the chute does to them. */
function rivalsAlone(seed: number, aware: boolean, tally: RivalTally): void {
  const t = course(seed);
  const c = t.chute[0];
  const sorted = [...t.obstacles].sort((a, b) => a.z - b.z);
  const player = new Player(); player.worldZ = -1e7; player.speed = 0;
  const finishZ = t.segments[t.segments.length - 1].z;
  const riders = t.aiRiders.map((params, i) => new AIRider(cupRivalParams(i, params)));
  const collisions = riders.map(() => new CollisionSystem());
  const seen = riders.map(() => new Set<Obstacle>());
  const entered = riders.map(() => false);
  const firstWall = riders.map(() => false);
  const lastSerial = riders.map(() => 0);
  const startZ = c.funnelStart * SEGMENT_LENGTH; const endZ = chuteEnd(c) * SEGMENT_LENGTH;
  for (let step = 0; step < 14_000 && riders.some((r) => !r.wipedOut && r.finishTimeMs === null); step++) {
    riders.forEach((r, i) => {
      if (r.wipedOut || r.finishTimeMs !== null) return;
      const near = windowed(sorted, r.worldZ);
      r.update(STEP, near, player, surfaceAtZ(t.segments, r.worldZ), aware ? chuteAhead(t.segments, r.worldZ) : false);
      if (r.worldZ >= finishZ) { r.finishTimeMs = step * STEP; r.worldZ = finishZ; }
      collisions[i].update(r, near);
      if (!entered[i] && r.worldZ >= startZ && !r.wipedOut) {
        entered[i] = true; tally.entered++; tally.passes++;
        if (r.laneIndex === 0 || r.laneIndex === LAST) tally.outerAtEntry++;
      }
      if (r.treeCrashSerial > lastSerial[i]) {
        lastSerial[i] = r.treeCrashSerial;
        const hit = near.find((o) => o.kind === 'tree' && collisions[i].wasHit(o) && !seen[i].has(o));
        if (hit) seen[i].add(hit);
        const inside = r.worldZ >= startZ && r.worldZ < endZ + SEGMENT_LENGTH;
        const wall = !!hit?.wall;
        if (wall) {
          tally.wallCrashes++;
          if (r.wipedOut) tally.wallEliminations++; else firstWall[i] = true;
        } else if (r.wipedOut) {
          if (inside) tally.otherEliminationsInChute++;
          else { tally.eliminationsElsewhere++; if (firstWall[i]) tally.wallThenElsewhere++; }
        }
      }
      if (entered[i] && r.worldZ >= endZ && r.worldZ < endZ + 2 * SEGMENT_LENGTH && !seen[i].has(sorted[0])) {
        seen[i].add(sorted[0]); tally.completed++;
      }
    });
  }
}

test('rivals: fewer than 1 wall crash per 20 chute passes and no chute eliminations (400 seeds x 4 rivals, no player)', () => {
  const aware = newTally(); const blind = newTally();
  const started = performance.now();
  for (const seed of SEEDS) { rivalsAlone(seed, true, aware); rivalsAlone(seed, false, blind); }
  const rate = (x: RivalTally) => x.wallCrashes / x.passes;
  info(`${SEEDS.length * 4} rival runs per column, ${Math.round(performance.now() - started)} ms`);
  info(`WITHOUT chute awareness (rivals as before): ${blind.passes} chute passes, ${blind.wallCrashes} wall crashes = 1 per ${(1 / rate(blind)).toFixed(1)} passes, ` +
    `${blind.wallEliminations} eliminations on the wall`);
  info(`WITH chute awareness: ${aware.passes} chute passes (${aware.outerAtEntry} arrived in lane 0/4), ${aware.wallCrashes} wall crashes = 1 per ` +
    `${aware.wallCrashes ? (1 / rate(aware)).toFixed(1) : '>' + aware.passes} passes (limit 1 per 20), ${aware.wallEliminations} eliminated on a wall tree (second strike), ` +
    `${aware.otherEliminationsInChute} other eliminations while in the chute, ${aware.eliminationsElsewhere} eliminations elsewhere on the course ` +
    `(${aware.wallThenElsewhere} of them after a first strike on a wall)`);
  assert.ok(blind.wallCrashes >= aware.wallCrashes);
  assert.ok(rate(aware) < 1 / 20, `wall crashes per pass ${rate(aware).toFixed(4)}`);
  assert.equal(aware.wallEliminations, 0, 'the chute eliminates nobody');
  assert.equal(aware.otherEliminationsInChute, 0, 'nobody is eliminated inside the chute at all');
});

/** Every lane x every production rival set down 30 segments before the funnel at its cruise speed: the worst arrival the course can give. */
function entryStress(aware: boolean) {
  const out = { runs: 0, crashes: 0, eliminated: 0, byPersonality: {} as Record<string, number> };
  for (const seed of SEEDS) {
    const t = course(seed);
    const c = t.chute[0];
    // Only the chute itself in the world: what happens before it is the ordinary forest's business.
    const sorted = t.obstacles.filter((o) => o.segIndex >= c.funnelStart && o.segIndex < chuteEnd(c) + 12).sort((a, b) => a.z - b.z);
    const player = new Player(); player.worldZ = -1e7; player.speed = 0;
    for (let i = 0; i < 4; i++) {
      for (let lane = 0; lane < LANES.length; lane++) {
        const r = new AIRider({ ...cupRivalParams(i, t.aiRiders[i]), startLane: lane, startZOffset: (c.funnelStart - 30) * SEGMENT_LENGTH });
        r.speed = MAX_SPEED * r.params.cruiseSpeedFactor;
        const cs = new CollisionSystem();
        for (let step = 0; step < 900 && r.worldZ < (chuteEnd(c) + 3) * SEGMENT_LENGTH && !r.wipedOut; step++) {
          const near = windowed(sorted, r.worldZ);
          r.update(STEP, near, player, undefined, aware ? chuteAhead(t.segments, r.worldZ) : false);
          cs.update(r, near);
        }
        out.runs++;
        if (r.treeStrikes > 0) {
          out.crashes++;
          out.byPersonality[r.personality] = (out.byPersonality[r.personality] ?? 0) + 1;
          if (r.wipedOut) out.eliminated++;
        }
      }
    }
  }
  return out;
}

test('rivals: from any lane, with any personality, the funnel gets every rival inward without a crash', () => {
  const blind = entryStress(false); const aware = entryStress(true);
  info(`${aware.runs} entries (all five lanes x NOVA / SLATE / FROST / EMBER x ${SEEDS.length} seeds, only the chute in view): ` +
    `WITHOUT awareness ${blind.crashes} wall crashes (1 per ${(blind.runs / Math.max(1, blind.crashes)).toFixed(1)}), ${blind.eliminated} eliminations ${JSON.stringify(blind.byPersonality)}; ` +
    `WITH awareness ${aware.crashes} wall crashes, ${aware.eliminated} eliminations ${JSON.stringify(aware.byPersonality)}`);
  assert.ok(aware.crashes / aware.runs < 1 / 20);
  assert.equal(aware.eliminated, 0);
  assert.ok(blind.crashes >= aware.crashes);
});

test('rivals: chute awareness outranks personality and the dodge\'s own lane check (synthetic cases the generator cannot rule out)', () => {
  const player = new Player(); player.worldZ = -1e7; player.speed = 0;
  const wallPair = (seg: number): Obstacle[] => [0, LAST].map((lane) => ({ kind: 'tree', lane, segIndex: seg, z: seg * SEGMENT_LENGTH + 100, wall: true }));
  const walls = [...Array(15).keys()].flatMap((k) => wallPair(300 + 2 * k));
  const rock = (lane: number, seg: number): Obstacle => ({ kind: 'rock', lane, segIndex: seg, z: seg * SEGMENT_LENGTH + 100 });
  const make = (personality: 'line-defender' | 'bully' | 'daredevil', startLane: number, seg: number) => new AIRider({
    cruiseSpeedFactor: 1, aggression: 0.5, reactionDistanceSegments: 7, startLane, startZOffset: seg * SEGMENT_LENGTH, paletteIndex: 0,
    personality, behaviorSeed: 5 });
  // (a) A line defender whose home lane is a wall lane: displaced to lane 1 in the funnel, it steps back into lane 0 as soon as
  //     no tree is within its sight; the awareness keeps it inward.
  for (const aware of [false, true]) {
    const r = make('line-defender', 0, 286);
    r.applyKnockback(1, 0);
    for (let i = 0; i < 20; i++) r.update(STEP, [], player, undefined, aware);   // settle in lane 1 (nothing to dodge)
    r.speed = MAX_SPEED * 0.5;
    let wentOut = false;
    for (let i = 0; i < 30; i++) { r.update(STEP, walls, player, undefined, aware); if (r.laneIndex === 0 || r.laneOffsetFraction < -0.5) wentOut = true; }
    assert.equal(wentOut, !aware, aware ? 'aware: stays in the inner lanes' : 'unaware: heads back for its home lane');
  }
  // (b) Recovering from a rock tumble in lane 0 with wall trees a segment ahead and a rock just inside them in lane 1: the
  //     dodge refuses a lane that is not clear, so only the awareness moves the rider.
  const blocked = [...walls, rock(1, 309)];
  for (const aware of [false, true]) {
    const r = make('bully', 0, 297);
    r.speed = MAX_SPEED; r.hitRock();
    for (let i = 0; i < 62; i++) r.update(STEP, blocked, player, undefined, aware);   // 1 s tumble, no steering
    for (let i = 0; i < 3; i++) r.update(STEP, blocked, player, undefined, aware);
    assert.equal(r.laneIndex === 0 && r.leanDirection === 0, !aware, aware ? 'aware: leaving lane 0' : 'unaware: sits in lane 0 because lane 1 has a rock in sight');
  }
});

test('rivals: one that crashes into the wall gets back inward after it recovers instead of taking a second strike', () => {
  let runs = 0; let recovered = 0;
  for (const seed of SEEDS) {
    const t = course(seed);
    const c = t.chute[0];
    const sorted = [...t.obstacles].sort((a, b) => a.z - b.z);
    const player = new Player(); player.worldZ = -1e7; player.speed = 0;
    for (let i = 0; i < 4; i++) {
      for (const lane of [0, LAST]) {
        const r = new AIRider({ ...cupRivalParams(i, t.aiRiders[i]), startLane: lane, startZOffset: (c.start + 6) * SEGMENT_LENGTH });
        const cs = new CollisionSystem();
        r.speed = MAX_SPEED; r.crashIntoTree(); // as if it had just hit the wall tree it stands beside
        assert.equal(r.treeStrikes, 1);
        for (let step = 0; step < 600 && r.worldZ < (chuteEnd(c) + 3) * SEGMENT_LENGTH && !r.wipedOut; step++) {
          const near = windowed(sorted, r.worldZ);
          r.update(STEP, near, player, undefined, chuteAhead(t.segments, r.worldZ));
          cs.update(r, near);
        }
        runs++;
        assert.equal(r.wipedOut, false, `seed ${seed} rival ${i} lane ${lane} took its second strike`);
        if (r.treeStrikes === 1) recovered++;
      }
    }
  }
  assert.equal(recovered, runs);
  info(`${runs} rivals set down in a wall lane at a wall tree after a first strike: ${recovered} stood up, moved inward and rode out on one strike`);
});

// ---- 6. combat ------------------------------------------------------------------------------
test('combat: a rival cannot knock the player into the wall, at the first and last wall tree or in the funnel (400 seeds)', () => {
  const w = { refusedInside: 0, checked: 0, funnelFar: 0, funnelFarEscaped: 0, funnelNear: 0 };
  for (const seed of SEEDS) {
    const t = course(seed);
    const c = t.chute[0];
    const walls = wallTrees(t);
    const first = walls[0]; const last = walls[walls.length - 1];
    const p = new Player();
    const combat = new CombatSystem(p, [], t.obstacles);
    const resolve = (fromLane: number, dir: -1 | 1, shift: number, z: number): number =>
      (combat as unknown as { resolveKnockbackLane(a: number, b: number, c: number, d: number): number }).resolveKnockbackLane(fromLane, dir, shift, z);
    // Every position from the funnel's first segment to the last wall tree, in half-segment steps: lane 1 -> 0 and 3 -> 4 (and the armed two-lane versions).
    for (let z = c.funnelStart * SEGMENT_LENGTH; z <= last.z; z += SEGMENT_LENGTH / 2) {
      const dangerous = z >= first.z - TREE_CLAMP_SEGMENTS * SEGMENT_LENGTH;
      for (const [from, dir] of [[1, -1], [3, 1]] as const) {
        const landed = resolve(from, dir, 1, z);
        const armed = resolve(from, dir, 2, z);
        if (dangerous) {
          assert.equal(landed, from, `seed ${seed}: knocked from lane ${from} into the wall at z=${z}`);
          assert.notEqual(armed, from + 2 * dir, `seed ${seed}: armed knockback into the wall at z=${z}`);
          w.refusedInside++;
        } else w.funnelFar++;
        w.checked++;
      }
    }
    // At the very first wall tree and two segments before it, then the last wall tree itself.
    for (const z of [first.z - 2 * SEGMENT_LENGTH, first.z - SEGMENT_LENGTH, first.z, last.z - SEGMENT_LENGTH, last.z]) {
      assert.equal(resolve(1, -1, 1, z), 1, `seed ${seed}: z=${z}`);
      assert.equal(resolve(3, 1, 1, z), 3);
    }
    // Past the last wall tree the wall lanes are open again (that is the road, not a hazard).
    assert.equal(resolve(1, -1, 1, last.z + 2 * SEGMENT_LENGTH), t.obstacles.some((o) => o.kind === 'tree' && o.lane === 0 &&
      o.z >= last.z + 2 * SEGMENT_LENGTH - SEGMENT_LENGTH / 2 && o.z <= last.z + 2 * SEGMENT_LENGTH + TREE_CLAMP_SEGMENTS * SEGMENT_LENGTH) ? 1 : 0);
    // Farther back than the clamp looks, a knockback into lane 0 / 4 IS allowed; it must be escapable.
    for (const [from, dir] of [[1, -1], [3, 1]] as const) {
      for (const behind of [TREE_CLAMP_SEGMENTS + 0.5, 7, 9]) {
        const z = first.z - behind * SEGMENT_LENGTH;
        if (z < c.funnelStart * SEGMENT_LENGTH) continue;
        const near = t.obstacles.filter((o) => o.segIndex >= c.funnelStart && o.segIndex < c.start + 6);
        const q = playerAt(from, z, MAX_SPEED);
        const cs = new CollisionSystem();
        const cb = new CombatSystem(q, [], near);
        const target = (cb as unknown as { resolveKnockbackLane(a: number, b: number, c: number, d: number): number }).resolveKnockbackLane(from, dir, 1, z);
        assert.equal(target, from + dir, 'allowed this far back');
        q.applyKnockback(target, 0.2);
        w.funnelNear++;
        // Steer back at the first moment steering works.
        for (let step = 0; step < 150 && q.worldZ < (c.start + 4) * SEGMENT_LENGTH; step++) {
          if (q.leanDirection === 0 && q.laneIndex === target) q.requestLaneShift(-dir as -1 | 1);
          q.update(STEP); cs.update(q, near);
        }
        w.funnelFar++;
        assert.equal(q.treeStrikes, 0, `seed ${seed}: knocked into lane ${target} ${behind} segments before the walls and could not get out`);
        w.funnelFarEscaped++;
      }
    }
  }
  info(`${w.refusedInside} knockbacks toward the wall refused across the funnel and walls (every half segment, ${SEEDS.length} courses, ordinary and armed); ` +
    `${w.funnelNear} knockbacks into a wall lane from beyond the ${TREE_CLAMP_SEGMENTS}-segment clamp (5.5, 7, 9 segments before the first tree) all escaped`);
});

test('combat: a rival attack on the player routes through that clamp (end to end)', () => {
  setDeterministicRuntime(7);
  const t = course(202);
  const c = t.chute[0];
  const first = wallTrees(t)[0];
  const attackAt = (z: number): number => {
    const p = playerAt(1, z, MAX_SPEED * 0.5);
    // A faster rival in the player's lane, and the player mid-tween toward the wall: the exchange knocks it toward lane 0.
    const r = new AIRider({ cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 1, startZOffset: z, paletteIndex: 0 });
    r.speed = MAX_SPEED;
    p.requestLaneShift(-1);
    for (let i = 0; i < 4; i++) p.update(STEP);
    const combat = new CombatSystem(p, [r], t.obstacles.filter((o) => o.segIndex >= c.funnelStart && o.segIndex < c.start + 8));
    combat.update(16, 1000);
    for (let i = 0; i < 40; i++) p.update(STEP);
    return p.laneIndex;
  };
  // Inside the clamp the player is never put in lane 0; the unobstructed funnel (7+ segments before) is where it can be.
  for (const behind of [0, 1, 2, 3, 4]) assert.notEqual(attackAt(first.z - behind * SEGMENT_LENGTH), 0, `${behind} segments before the first wall tree`);
  assert.ok(first.z > c.funnelStart * SEGMENT_LENGTH);
  // Control: the same exchange with the wall trees taken away DOES put the player in lane 0, so the clamp is what refused it.
  const bare = t.obstacles.filter((o) => !o.wall && o.segIndex >= c.funnelStart && o.segIndex < c.start + 8);
  const p = playerAt(1, first.z - SEGMENT_LENGTH, MAX_SPEED * 0.5);
  const r = new AIRider({ cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 1, startZOffset: first.z - SEGMENT_LENGTH, paletteIndex: 0 });
  r.speed = MAX_SPEED;
  p.requestLaneShift(-1);
  for (let i = 0; i < 4; i++) p.update(STEP);
  new CombatSystem(p, [r], bare).update(16, 1000);
  for (let i = 0; i < 40; i++) p.update(STEP);
  assert.equal(p.laneIndex, 0, 'without the walls the same attack does knock the player to lane 0');
});

test('shove: the player can push a rival from lane 1 into the wall: hazard cue, tree crash, and a knockout on the second strike', () => {
  setDeterministicRuntime(7);
  const t = course(42);
  const c = t.chute[0];
  const walls = wallTrees(t);
  const mid = walls.find((o) => o.lane === 0 && o.segIndex >= c.start + 6)!;
  const z = mid.z - 2 * SEGMENT_LENGTH;
  const field = t.obstacles.filter((o) => o.segIndex >= c.start && o.segIndex < chuteEnd(c) + 2);
  const setup = (strikes: number) => {
    const p = playerAt(2, z);
    const r = new AIRider({ cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 6, startLane: 1, startZOffset: z, paletteIndex: 0 });
    r.worldZ = z; r.speed = MAX_SPEED * 0.9;
    for (let i = 0; i < strikes; i++) { r.crashIntoTree(); for (let s = 0; s < 400; s++) r.update(STEP, [], p); } // first strike long recovered
    r.worldZ = z; r.speed = MAX_SPEED * 0.9; // back at the spot, the first strike long recovered
    const combat = new CombatSystem(p, [r], field);
    (combat as unknown as { inContact: Set<AIRider> }).inContact.add(r);
    combat.update(16, 1000);
    return { p, r, combat };
  };
  const first = setup(0);
  const plan = first.combat.pushPlan(first.r, 0);
  assert.equal(plan.lane, 0, 'pushed away from the player, toward the wall');
  assert.equal(plan.hazard, 'tree', 'the "!" on the arrow and TREE AHEAD read this');
  assert.equal(first.combat.attemptPush(1000, 0), true);
  const cs = new CollisionSystem();
  let hitTree = false;
  for (let i = 0; i < 90 && !hitTree; i++) {
    first.p.update(STEP); first.r.update(STEP, field, first.p); cs.update(first.r, field);
    hitTree = first.r.treeCrashSerial > 0;
  }
  assert.equal(hitTree, true, 'the shove puts the rival into a wall tree');
  assert.equal(first.r.treeStrikes, 1); assert.equal(first.r.wipedOut, false, 'a first strike is a heavy crash');
  // A rival already on one strike is eliminated: the player is credited the knockout.
  const second = setup(1);
  assert.equal(second.r.treeStrikes, 1);
  assert.equal(second.combat.pushPlan(second.r, 0).hazard, 'tree');
  second.combat.attemptPush(2000, 0);
  const cs2 = new CollisionSystem();
  for (let i = 0; i < 90 && !second.r.wipedOut; i++) { second.p.update(STEP); second.r.update(STEP, field, second.p); cs2.update(second.r, field); }
  assert.equal(second.r.wipedOut, true, 'the second strike eliminates');
  second.combat.update(16, 2000 + KNOCKOUT_WINDOW_MS - 100);
  assert.equal(second.combat.events.filter((e) => e.type === 'knockout').length, 1, 'and the knockout is the player\'s');
});

// ---- 7. the player in the wall --------------------------------------------------------------
test('player: after a first wall strike, steering inward at the first steerable moment never costs the second strike', () => {
  let runs = 0; let controls = 0; let drifted = 0;
  for (const seed of SEEDS) {
    const t = course(seed);
    const c = t.chute[0];
    const walls = wallTrees(t);
    // The walls and what stands between them; what follows the chute is the ordinary forest's business.
    const field = t.obstacles.filter((o) => o.segIndex >= c.funnelStart && o.segIndex < chuteEnd(c));
    for (const lane of [0, LAST]) {
      const side = walls.filter((o) => o.lane === lane);
      for (const target of [side[0], side[Math.floor(side.length / 2)], side[side.length - 2]]) {
        const crash = (steer: boolean) => {
          const p = playerAt(lane, target.z - 3 * SEGMENT_LENGTH);
          const cs = new CollisionSystem();
          let steered = false;
          for (let step = 0; step < 900 && p.worldZ < chuteEnd(c) * SEGMENT_LENGTH && !p.wipedOut; step++) {
            if (steer && p.treeStrikes > 0 && !steered && !p.heavyCrashing) {
              p.requestLaneShift(lane === 0 ? 1 : -1);
              steered = p.leanDirection !== 0 || p.laneIndex !== lane;
            }
            p.update(STEP); cs.update(p, field);
          }
          return p;
        };
        const ok = crash(true);
        runs++;
        assert.equal(ok.treeStrikes, 1, `seed ${seed}: lane ${lane}, tree at ${target.segIndex}, struck ${ok.treeStrikes} times`);
        assert.equal(ok.wipedOut, false);
        // Control: the same rider NOT steering is wiped out by a later wall tree once immunity ends (immunity covers
        // ~8 segments of the run-up; where fewer than that many wall trees remain it simply rides out the chute).
        if (target.segIndex + 14 < chuteEnd(c)) { controls++; if (crash(false).wipedOut) drifted++; }
      }
    }
  }
  assert.ok(controls > 100);
  assert.equal(drifted, controls, 'a rider who does not steer is wiped out by the next wall tree after immunity ends');
  info(`${runs} first strikes (first / middle / second-to-last wall tree, both sides, ${SEEDS.length} courses): steering at the first steerable moment -> exactly 1 strike each, no wipeout; ` +
    `the same rider NOT steering is wiped out in ${drifted}/${controls} of the runs with room for it`);
});

// ---- 8. rendering cost ----------------------------------------------------------------------
test('rendering: obstacle sprites in view stay small, and the walls add a bounded number', () => {
  let maxWith = 0; let maxWithout = 0; let maxWalls = 0;
  for (const seed of SEEDS) {
    const t = course(seed);
    const c = t.chute[0];
    const bare = generateTrack(seed, { chute: false });
    for (let seg = c.funnelStart - DRAW_DISTANCE; seg < chuteEnd(c); seg += 2) {
      const lo = seg * SEGMENT_LENGTH; const hi = lo + DRAW_DISTANCE * SEGMENT_LENGTH;
      const inView = (o: Obstacle) => o.z >= lo && o.z < hi;
      maxWith = Math.max(maxWith, t.obstacles.filter(inView).length);
      maxWithout = Math.max(maxWithout, bare.obstacles.filter(inView).length);
      maxWalls = Math.max(maxWalls, t.obstacles.filter((o) => inView(o) && o.wall).length);
    }
  }
  info(`DRAW_DISTANCE ${DRAW_DISTANCE} segments: at most ${maxWith} obstacle sprites in view with a chute (${maxWithout} without), ${maxWalls} of them wall trees`);
  assert.ok(maxWalls <= 2 * Math.ceil(30 / 2));
  assert.ok(maxWith <= 64, 'a pooled-sprite count the renderer copes with');
});

console.log(`\n=== ${passed} chute checks passed ===`);
