/** Deterministic pack pacing: real entities, seeded slopes, dodge/collision/combat.
 * A simple defensive driver supplies legal player inputs; it neither moves the
 * player directly nor repairs crashes. Proximity metrics are geometry, not a
 * claim that every nearby rival survives crest occlusion in the renderer.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AI_CRUISE_SPEED_MAX_FACTOR, MAX_SPEED, PLAYER_ACCEL, SEGMENT_LENGTH, SHOVE_Z_WINDOW, ROCK_SPEED_FACTOR } from '../src/config';
import { AIRider, PACK_CHASE_START_Z, PACK_CHASE_END_Z, PACK_SETBACK_GRACE_MS, type AIRiderParams } from '../src/entities/aiRider';
import { CollisionSystem, isMogulLaunchAvailable } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { generateTrack } from '../src/track/generator';

/** The pre-pacing cruise rule, with all the same dodge/collision/combat code. */
class BaselineRider extends AIRider {
  protected cruiseSpeedFor(_player: Player): number { return MAX_SPEED * this.params.cruiseSpeedFactor; }
}
const SEEDS = [1, 2, 3, 7, 11, 21, 42, 77, 101, 202, 333, 777];
const STEP = 20;
const params = (extra: Partial<AIRiderParams> = {}): AIRiderParams => ({
  cruiseSpeedFactor: 0.9, aggression: 0, reactionDistanceSegments: 8,
  startLane: 1, startZOffset: 1200, paletteIndex: 0, ...extra
});

function drive(player: Player, obstacles: Obstacle[]): void {
  if (player.wipedOut || player.airborne || player.tumbling || player.swinging || player.leanDirection) return;
  const nearest = (lane: number) => obstacles.filter((o) => o.lane === lane && o.z >= player.worldZ - 80)
    .reduce<Obstacle | null>((best, o) => !best || o.z < best.z ? o : best, null);
  const current = nearest(player.laneIndex);
  if (!current || current.z - player.worldZ > 1400) return;
  const candidates = [player.laneIndex - 1, player.laneIndex + 1].filter((lane) => lane >= 0 && lane < 5)
    .map((lane) => ({ lane, clearance: (nearest(lane)?.z ?? Infinity) - player.worldZ }))
    .sort((a, b) => b.clearance - a.clearance);
  if (candidates[0]?.clearance > 1000) {
    player.requestLaneShift(candidates[0].lane > player.laneIndex ? 1 : -1);
  } else if (current.kind !== 'tree' && current.z - player.worldZ < 420 &&
      !obstacles.some((o) => o.kind === 'tree' && o.lane === player.laneIndex && o.z > player.worldZ && o.z < player.worldZ + 4000)) {
    player.jump(isMogulLaunchAvailable(player, obstacles));
  }
}

function simulate(seed: number, improved: boolean, withHazards = true) {
  setDeterministicRuntime(seed * 997);
  const generated = generateTrack(seed);
  const obstacles = withHazards ? generated.obstacles : [];
  const player = new Player();
  const riders = generated.aiRiders.map((p) => improved ? new AIRider(p) : new BaselineRider(p));
  const collisions = riders.map(() => new CollisionSystem());
  const playerCollisions = new CollisionSystem();
  const combat = new CombatSystem(player, riders, obstacles);
  const finishZ = generated.segments[generated.segments.length - 1].z;
  const crests = generated.crestApexes.map((index) => index * SEGMENT_LENGTH + SEGMENT_LENGTH / 2);
  let sampledMs = 0, packMs = 0, nearMs = 0, opportunityMs = 0;
  let hits = 0, brushes = 0, knockouts = 0, rockHits = 0, mogulHits = 0;
  let elapsed = 0;
  let earlyGaps: number[] = [];
  const seen = riders.map(() => new Set<Obstacle>());
  for (let time = STEP; time <= 180_000; time += STEP) {
    drive(player, obstacles);
    // Fight only where the committed quarter-second has clear runway.
    if (time % 1200 === 0 && !obstacles.some((o) => o.lane === player.laneIndex && o.z > player.worldZ && o.z < player.worldZ + 1800)) {
      combat.attemptAttack(time);
    }
    const previousZ = player.worldZ;
    player.update(STEP);
    if (crests.some((z) => previousZ < z && player.worldZ >= z)) player.jump(true);
    playerCollisions.update(player, obstacles);
    riders.forEach((r, i) => {
      r.update(STEP, obstacles, player);
      if (r.finishTimeMs === null && r.worldZ >= finishZ) r.finishTimeMs = time;
      if (r.finishTimeMs !== null) r.worldZ = finishZ;
      collisions[i].update(r, obstacles);
      for (const obstacle of obstacles) if (!seen[i].has(obstacle) && collisions[i].wasHit(obstacle)) {
        seen[i].add(obstacle);
        if (obstacle.kind === 'rock') rockHits++;
        if (obstacle.kind === 'mogul') mogulHits++;
      }
    });
    combat.update(STEP, time);
    for (const event of combat.events) {
      if (event.type === 'hit') hits++;
      else if (event.type === 'brush') brushes++;
      else knockouts++;
    }
    combat.events.length = 0;
    elapsed = time;
    if (time === 5500) earlyGaps = riders.map((r) => Math.round(r.worldZ - player.worldZ));
    if (time >= 5000) {
      sampledMs += STEP;
      const live = riders.filter((r) => !r.wipedOut && r.finishTimeMs === null);
      // The flat projection shows approximately350u behind and6000u ahead.
      if (live.some((r) => r.worldZ - player.worldZ >= -350 && r.worldZ - player.worldZ <= 6000)) packMs += STEP;
      if (live.some((r) => Math.abs(r.worldZ - player.worldZ) <= 1200)) nearMs += STEP;
      if (live.some((r) => Math.abs(r.worldZ - player.worldZ) <= SHOVE_Z_WINDOW && Math.abs(r.laneIndex - player.laneIndex) <= 1 &&
        !r.collisionImmune && !player.collisionImmune && !player.airborne)) opportunityMs += STEP;
    }
    if (player.wipedOut || player.worldZ >= finishZ) break;
  }
  return { seed, elapsed, sampledMs, packMs, nearMs, opportunityMs, hits, brushes, knockouts, rockHits, mogulHits,
    riderWipeouts: riders.filter((r) => r.wipedOut).length, playerWipedOut: player.wipedOut, earlyGaps };
}

const summarize = (runs: ReturnType<typeof simulate>[]) => {
  const sum = (key: 'sampledMs' | 'packMs' | 'nearMs' | 'opportunityMs' | 'elapsed' | 'hits' | 'brushes' | 'knockouts' | 'rockHits' | 'mogulHits' | 'riderWipeouts') => runs.reduce((n, r) => n + r[key], 0);
  return {
    raceSeconds: sum('elapsed') / 1000, sampledSeconds: sum('sampledMs') / 1000,
    visibleBandPercent: 100 * sum('packMs') / sum('sampledMs'),
    nearbyPackPercent: 100 * sum('nearMs') / sum('sampledMs'),
    combatOpportunityPercent: 100 * sum('opportunityMs') / sum('sampledMs'),
    hits: sum('hits'), brushes: sum('brushes'), knockouts: sum('knockouts'),
    rockHits: sum('rockHits'), mogulHits: sum('mogulHits'), riderWipeouts: sum('riderWipeouts')
  };
};
const before = SEEDS.map((seed) => simulate(seed, false));
const after = SEEDS.map((seed) => simulate(seed, true));
const clearBefore = SEEDS.map((seed) => simulate(seed, false, false));
const clearAfter = SEEDS.map((seed) => simulate(seed, true, false));
const report = { seeds: SEEDS, withHazards: { before: summarize(before), after: summarize(after), runsBefore: before, runsAfter: after },
  clearCourse: { before: summarize(clearBefore), after: summarize(clearAfter) } };
console.log('\n=== pack pacing: 12 seeded full-course attempts, legal player controls ===');
console.log('With real hazards:', JSON.stringify({ before: report.withHazards.before, after: report.withHazards.after }, null, 2));
console.log('Clear-course proximity:', JSON.stringify({ before: report.clearCourse.before, after: report.clearCourse.after }, null, 2));
mkdirSync('.verify', { recursive: true });
writeFileSync('.verify/pacing-report.json', JSON.stringify(report, null, 2));

let passed = 0;
function check(label: string, run: () => void) { run(); passed++; console.log(`  PASS  ${label}`); }
check('nearby rivals retain native cruise and speed advantages', () => {
  const player = new Player(); player.speed = MAX_SPEED;
  for (const factor of [0.9, 0.98, 1.05]) {
    const r = new AIRider(params({ cruiseSpeedFactor: factor, startZOffset: player.worldZ - 100 }));
    r.speed = MAX_SPEED * factor;
    r.update(50, [], player);
    assert.equal(r.speed, MAX_SPEED * factor);
  }
});
check('distant catch-up uses existing 105% cap and ordinary acceleration only', () => {
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
  const r = new AIRider(params({ startZOffset: 10_000 - PACK_CHASE_START_Z - 500 }));
  r.speed = MAX_SPEED * 0.9;
  let previousSpeed = r.speed;
  for (let t = 0; t < 3000; t += STEP) {
    player.update(STEP);
    const previousZ = r.worldZ;
    r.update(STEP, [], player);
    assert.ok(r.speed <= MAX_SPEED * AI_CRUISE_SPEED_MAX_FACTOR);
    assert.ok(r.speed - previousSpeed <= PLAYER_ACCEL * STEP / 1000 + 1e-9);
    assert.ok(Math.abs(r.worldZ - previousZ - r.speed * STEP / 1000) < 1e-9, 'catch-up must be actual physical travel');
    previousSpeed = r.speed;
  }
  assert.ok(r.speed > MAX_SPEED);
});
check('chase persists inside the start gap, then releases before combat even at 50ms steps', () => {
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
  const r = new AIRider(params({ startZOffset: 10_000 - PACK_CHASE_START_Z - 100 }));
  r.speed = MAX_SPEED * 0.9;
  let reachedPack = false;
  for (let t = 0; t < 20_000; t += 50) {
    player.update(50);
    r.update(50, [], player);
    const gap = player.worldZ - r.worldZ;
    if (gap <= SHOVE_Z_WINDOW) assert.ok(r.speed <= MAX_SPEED * r.params.cruiseSpeedFactor);
    if (gap < PACK_CHASE_END_Z + 50 && r.speed === MAX_SPEED * r.params.cruiseSpeedFactor) { reachedPack = true; break; }
  }
  assert.equal(reachedPack, true, 'wide-gap chase must reconnect with the nearby pack');
});
for (const [label, damage] of [
  ['combat hit', (r: AIRider) => { r.applyKnockback(1, 0.2); r.notifyHit(); }],
  ['rock', (r: AIRider) => r.hitRock()],
  ['mogul', (r: AIRider) => r.hitMogul()]
] as const) check(`${label} recovery gets no catch-up for the full setback grace`, () => {
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
  const source = params({ startZOffset: 10_000 - PACK_CHASE_START_Z - 500 });
  const changed = new AIRider(source); const baseline = new BaselineRider(source);
  changed.speed = baseline.speed = MAX_SPEED * source.cruiseSpeedFactor;
  damage(changed); damage(baseline);
  for (let elapsed = STEP; elapsed < PACK_SETBACK_GRACE_MS; elapsed += STEP) {
    player.update(STEP);
    changed.update(STEP, [], player); baseline.update(STEP, [], player);
    assert.equal(changed.speed, baseline.speed);
    assert.equal(changed.worldZ, baseline.worldZ);
    assert.equal(changed.tumbling, baseline.tumbling);
  }
});
check('rock impact keeps its exact speed loss and complete steering lock', () => {
  const r = new AIRider(params()); const player = new Player();
  r.speed = MAX_SPEED;
  r.hitRock();
  assert.equal(r.speed, MAX_SPEED * ROCK_SPEED_FACTOR);
  assert.equal(r.tumbling, true);
  r.update(999, [], player);
  assert.equal(r.tumbling, true);
  r.update(1, [], player);
  assert.equal(r.tumbling, false);
});
check('a player setback cannot activate catch-up assistance', () => {
  const player = new Player(); player.worldZ = 10_000; player.speed = MAX_SPEED * 0.5;
  const r = new AIRider(params({ startZOffset: 1000 })); r.speed = MAX_SPEED * 0.9;
  r.update(50, [], player);
  assert.equal(r.speed, MAX_SPEED * 0.9);
  player.crashIntoTree();
  r.update(50, [], player);
  assert.equal(r.speed, MAX_SPEED * 0.9);
});
check('finished and wiped-out opponents never move or resurrect', () => {
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 100_000;
  const out = new AIRider(params()); out.speed = MAX_SPEED; out.crashIntoTree();
  const finished = new AIRider(params()); finished.speed = MAX_SPEED; finished.finishTimeMs = 1;
  const outZ = out.worldZ; const finishZ = finished.worldZ;
  for (let i = 0; i < 100; i++) { out.update(50, [], player); finished.update(50, [], player); }
  assert.equal(out.worldZ, outZ); assert.equal(out.speed, 0); assert.equal(out.wipedOut, true);
  assert.equal(finished.worldZ, finishZ); assert.equal(finished.finishTimeMs, 1);
});
check('catch-up does not move a rider during a zero-delta start/countdown frame', () => {
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 100_000;
  const r = new AIRider(params()); const z = r.worldZ;
  r.update(0, [], player);
  assert.equal(r.worldZ, z); assert.equal(r.speed, 0);
});
check('earned knockout attribution window stays unchanged', () => {
  const r = new AIRider(params());
  r.markShovedByPlayer(1000);
  assert.equal(r.wasRecentlyShovedByPlayer(2999, 2000), true);
  assert.equal(r.wasRecentlyShovedByPlayer(3001, 2000), false);
});
check('full-course samples include natural collisions and successful finishes', () => {
  assert.ok(after.some((run) => !run.playerWipedOut && run.elapsed < 180_000));
  assert.ok(report.withHazards.after.rockHits > 0);
  assert.ok(report.withHazards.after.mogulHits > 0);
  assert.ok(report.withHazards.after.brushes > 0);
});
check('bounded pacing improves sustained proximity without removing real wipeouts', () => {
  assert.ok(report.withHazards.after.nearbyPackPercent > report.withHazards.before.nearbyPackPercent + 15);
  assert.ok(report.withHazards.after.visibleBandPercent >= report.withHazards.before.visibleBandPercent);
  assert.ok(report.withHazards.after.riderWipeouts > 0);
  assert.ok(report.clearCourse.after.nearbyPackPercent > report.clearCourse.before.nearbyPackPercent + 15);
});
check('seeded simulations are repeatable', () => assert.deepEqual(simulate(101, true), after.find((r) => r.seed === 101)));
console.log(`\n${passed} pacing regressions passed.`);
