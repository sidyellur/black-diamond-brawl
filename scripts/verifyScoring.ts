/** Gameplay scoring and feedback regressions. Deterministic, no Phaser/DOM. */
import assert from 'node:assert/strict';
import {
  JUMP_AIRTIME_EXTENDED_MS, JUMP_AIRTIME_MS, MAX_SPEED,
  NEAR_MISS_MIN_SPEED_FACTOR, PAR_TIME, POINTS, WEAPON_CHARGES
} from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem, type CombatEvent } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { computePlayerPosition, ScoreTracker, type ScoreBreakdown } from '../src/entities/scoring';

let passed = 0;
let failed = 0;
function check(name: string, run: () => void): void {
  try { run(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failed++; console.error(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : error}`); }
}
function rider(lane = 3, z = 1_000_000): AIRider {
  return new AIRider({ cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8,
    startLane: lane, startZOffset: z, paletteIndex: 0 });
}
function obstacle(kind: Obstacle['kind'], lane: number, z: number): Obstacle {
  return { kind, lane, z, segIndex: Math.floor(z / 200) };
}
function rig(obstacles: Obstacle[] = [], riders: AIRider[] = []) {
  setDeterministicRuntime(71);
  const player = new Player();
  // Isolated scoring fixtures use this explicit origin, independent of the
  // production camera/start-line offset. Their obstacles/rivals sit at 1300.
  player.worldZ = 1200;
  player.speed = MAX_SPEED;
  const collisions = new CollisionSystem();
  const combat = new CombatSystem(player, riders, obstacles);
  const score = new ScoreTracker(player, riders, obstacles, collisions, combat);
  const source = riders[0] ?? rider();
  const emit = (type: CombatEvent['type'] = 'hit', delta = 0) => {
    combat.events.push({ type, rider: source });
    score.update(delta);
  };
  return { player, collisions, combat, score, emit };
}
function categoryTotal(score: ScoreBreakdown): number {
  return score.combatHitPoints + score.brushPoints + score.knockoutPoints +
    score.nearMissPoints + score.trickJumpPoints + score.chainBonusPoints;
}

console.log('\n=== scoring, flow, and feedback ===');
check('combat events retain distinct base points, counts, labels and ordering', () => {
  const { combat, score } = rig();
  const source = rider();
  combat.events.push({ type: 'hit', rider: source }, { type: 'brush', rider: source }, { type: 'knockout', rider: source });
  score.update(0);
  assert.deepEqual(score.feedback, [
    { kind: 'hit', label: 'CLEAN HIT', points: POINTS.COMBAT_HIT },
    { kind: 'brush', label: 'BODY CHECK', points: POINTS.COMBAT_BRUSH },
    { kind: 'knockout', label: 'KNOCKOUT', points: POINTS.KNOCKOUT }
  ]);
  const result = score.finalize(false, 9000, 5);
  assert.equal(result.combatHitCount, 1);
  assert.equal(result.brushCount, 1);
  assert.equal(result.knockoutCount, 1);
  assert.equal(result.eventTotal, 800);
  assert.equal(combat.events.length, 0);
});
check('feedback describes only this frame and event draining prevents duplicates', () => {
  const { score, emit } = rig();
  emit();
  const total = score.runningScore;
  assert.equal(score.feedback.length, 1);
  score.update(16);
  assert.equal(score.feedback.length, 0);
  assert.equal(score.runningScore, total);
});
check('flow starts bonus at event five, reaches +50% at nine, and never exceeds cap', () => {
  const { score, emit } = rig();
  let total = 0;
  let bonuses = 0;
  for (let event = 1; event <= 28; event++) {
    const bonus = Math.round(POINTS.COMBAT_HIT * Math.min(2, Math.floor((event - 1) / 4)) * 0.25);
    bonuses += bonus;
    total += POINTS.COMBAT_HIT + bonus;
    emit();
    assert.equal(score.feedback[0].points, POINTS.COMBAT_HIT + bonus, `event ${event}`);
    assert.equal(score.runningScore, total);
    assert.equal(score.chain, event);
    assert.ok(score.feedback[0].points <= POINTS.COMBAT_HIT * 1.5);
  }
  const result = score.finalize(false, 1000, 1);
  assert.equal(result.chainBonusPoints, bonuses);
  assert.equal(result.maxChain, 28);
  assert.equal(result.combatHitPoints, POINTS.COMBAT_HIT * 28);
  assert.equal(result.eventTotal, categoryTotal(result));
});
check('flow expires at exactly 4.2 seconds and each clean event refreshes it', () => {
  const { score, emit } = rig();
  emit();
  score.update(4199);
  assert.equal(score.chain, 1);
  assert.equal(score.chainRemaining, 1 / 4200);
  emit();
  assert.equal(score.chain, 2);
  assert.equal(score.chainRemaining, 1);
  score.update(4200);
  assert.equal(score.chain, 0);
  assert.equal(score.chainRemaining, 0);
  emit();
  assert.equal(score.chain, 1);
  assert.equal(score.feedback[0].points, POINTS.COMBAT_HIT);
  assert.equal(score.finalize(false, 0, 1).maxChain, 2);
});
check('a long idle frame expires flow once without negative remaining time', () => {
  const { score, emit } = rig();
  emit();
  score.update(99_999);
  assert.equal(score.chain, 0);
  assert.equal(score.chainRemaining, 0);
  assert.equal(score.runningScore, POINTS.COMBAT_HIT);
});
for (const [label, damage] of [
  ['rock tumble', (p: Player) => p.hitRock()],
  ['mogul stumble', (p: Player) => p.hitMogul()],
  ['losing a combat exchange', (p: Player) => p.notifyHit()],
  ['tree wipeout', (p: Player) => p.crashIntoTree()]
] as const) {
  check(`${label} breaks flow and preserves already earned score`, () => {
    const { player, score, emit } = rig();
    for (let i = 0; i < 9; i++) emit();
    const earned = score.runningScore;
    damage(player);
    score.update(0);
    assert.equal(score.chain, 0);
    assert.equal(score.chainRemaining, 0);
    assert.equal(score.runningScore, earned);
    assert.equal(score.finalize(false, 10_000, 5).maxChain, 9);
  });
}
check('same-frame damage cannot restart flow or award a bonus on an earned knockout', () => {
  const { player, score, emit } = rig();
  for (let i = 0; i < 8; i++) emit();
  const earned = score.runningScore;
  player.notifyHit();
  emit('knockout');
  assert.equal(score.runningScore, earned + POINTS.KNOCKOUT);
  assert.equal(score.feedback[0].points, POINTS.KNOCKOUT);
  assert.equal(score.chain, 0);
  assert.equal(score.chainRemaining, 0);
});
check('same-frame stumble plus adjacent obstacle does not count as a clean close call', () => {
  const near = obstacle('tree', 3, 1220);
  const { player, score } = rig([near]);
  player.hitMogul();
  player.worldZ = near.z;
  score.update(16);
  assert.equal(score.runningScore, 0);
  assert.equal(score.chain, 0);
  assert.deepEqual(score.feedback, []);
});
check('clean extended landing scores its exact airtime bonus once', () => {
  const { player, score } = rig();
  player.jump(true);
  score.update(0);
  player.update(JUMP_AIRTIME_EXTENDED_MS - 1);
  score.update(JUMP_AIRTIME_EXTENDED_MS - 1);
  assert.equal(score.runningScore, 0);
  player.update(1);
  score.update(1);
  const points = POINTS.TRICK_JUMP + Math.floor((JUMP_AIRTIME_EXTENDED_MS - JUMP_AIRTIME_MS) / 250) * POINTS.TRICK_JUMP_EXTRA_PER_QUARTER_SECOND;
  assert.deepEqual(score.feedback, [{ kind: 'trick', label: 'STOMPED IT', points }]);
  assert.equal(score.finalize(false, 1200, 1).trickJumpCount, 1);
  score.update(16);
  assert.equal(score.runningScore, points);
  assert.deepEqual(score.feedback, []);
});
check('normal jumps and midair tree wipeouts never score a landed trick', () => {
  const normal = rig();
  normal.player.jump(false);
  normal.score.update(0);
  normal.player.update(JUMP_AIRTIME_MS);
  normal.score.update(JUMP_AIRTIME_MS);
  assert.equal(normal.score.runningScore, 0);
  const crash = rig();
  crash.player.jump(true);
  crash.score.update(0);
  crash.player.crashIntoTree();
  crash.score.update(16);
  assert.equal(crash.score.runningScore, 0);
  assert.equal(crash.score.finalize(false, 500, 5).trickJumpCount, 0);
});
for (const kind of ['rock', 'mogul'] as const) {
  check(`an extended jump landing on a ${kind} earns no trick or flow`, () => {
    const { player, collisions, score } = rig();
    player.jump(true);
    score.update(0);
    player.update(JUMP_AIRTIME_EXTENDED_MS);
    collisions.update(player, [obstacle(kind, player.laneIndex, player.worldZ)]);
    score.update(JUMP_AIRTIME_EXTENDED_MS);
    assert.equal(score.runningScore, 0);
    assert.equal(score.chain, 0);
    assert.equal(score.finalize(false, 1200, 5).trickJumpCount, 0);
  });
}
check('an obstacle crossing awards one close call, including exact-Z arrival', () => {
  const near = obstacle('tree', 3, 1300);
  const { player, score } = rig([near]);
  player.worldZ = near.z;
  score.update(16);
  assert.deepEqual(score.feedback, [{ kind: 'near', label: 'CLOSE CALL', points: POINTS.NEAR_MISS }]);
  player.worldZ = 1100;
  score.update(16);
  player.worldZ = 1400;
  score.update(16);
  assert.equal(score.runningScore, POINTS.NEAR_MISS);
});
check('near misses require speed at crossing, stay one-shot, and reject distant lanes', () => {
  const near = obstacle('rock', 3, 1300);
  const far = obstacle('tree', 0, 1400);
  const { player, score } = rig([near, far]);
  player.speed = MAX_SPEED * NEAR_MISS_MIN_SPEED_FACTOR - 1;
  player.worldZ = 1300;
  score.update(16);
  player.speed = MAX_SPEED;
  player.worldZ = 1100;
  score.update(16);
  player.worldZ = 1500;
  score.update(16);
  assert.equal(score.runningScore, 0);
});
check('a real obstacle hit is never also scored as a near miss', () => {
  const hit = obstacle('mogul', 2, 1300);
  const { player, collisions, score } = rig([hit]);
  player.worldZ = 1300;
  collisions.update(player, [hit]);
  score.update(16);
  assert.equal(collisions.wasHit(hit), true);
  assert.equal(score.runningScore, 0);
});
check('rival crossing through an exact-Z tie scores once rather than disappearing', () => {
  const rival = rider(3, 1300);
  const { player, score } = rig([], [rival]);
  player.worldZ = rival.worldZ;
  score.update(16);
  player.worldZ += 20;
  score.update(16);
  assert.equal(score.runningScore, POINTS.NEAR_MISS);
  player.worldZ -= 40;
  score.update(16);
  assert.equal(score.runningScore, POINTS.NEAR_MISS);
});
check('rival overtakes count once; same-lane combat and wiped-out rivals are excluded', () => {
  const passing = rider(1, 1180);
  const sameLane = rider(2, 1180);
  const wiped = rider(3, 1180);
  const { score } = rig([], [passing, sameLane, wiped]);
  wiped.crashIntoTree();
  [passing, sameLane, wiped].forEach((r) => { r.worldZ = 1220; });
  score.update(16);
  assert.equal(score.runningScore, POINTS.NEAR_MISS);
  [passing, sameLane, wiped].forEach((r) => { r.worldZ = 1180; });
  score.update(16);
  assert.equal(score.runningScore, POINTS.NEAR_MISS);
});
check('mixed-category breakdown sums exactly, with chain bonus shown separately', () => {
  const near = obstacle('tree', 3, 1300);
  const { player, score, emit } = rig([near]);
  emit('hit'); emit('hit'); emit('brush'); emit('knockout');
  player.worldZ = near.z;
  score.update(16);
  player.jump(true);
  score.update(0);
  player.update(JUMP_AIRTIME_EXTENDED_MS);
  score.update(JUMP_AIRTIME_EXTENDED_MS);
  const result = score.finalize(true, 120_500, 2);
  assert.equal(result.combatHitPoints, 500);
  assert.equal(result.brushPoints, 50);
  assert.equal(result.knockoutPoints, 500);
  assert.equal(result.nearMissPoints, 100);
  assert.equal(result.trickJumpPoints, 250);
  assert.equal(result.chainBonusPoints, 88);
  assert.equal(result.maxChain, 6);
  assert.equal(result.eventTotal, categoryTotal(result));
  assert.equal(result.total, result.eventTotal + result.completionBonus + result.timeBonus + result.positionBonus);
  assert.equal(result.finishTimeSeconds, 120.5);
  assert.equal(result.timeBonus, (PAR_TIME - 120.5) * POINTS.TIME_BONUS_PER_SECOND_UNDER_PAR);
  assert.equal(result.positionBonus, POINTS.POSITION_BONUS_SECOND);
  assert.equal(score.runningScore, result.eventTotal);
});
check('finalization is repeatable and finish bonuses do not leak into live event score', () => {
  const { score, emit } = rig();
  emit();
  const result = score.finalize(true, 100_000, 1);
  assert.deepEqual(score.finalize(true, 100_000, 1), result);
  assert.equal(score.runningScore, POINTS.COMBAT_HIT);
  assert.equal(result.completionBonus, POINTS.COMPLETION_BONUS);
  assert.equal(result.timeBonus, (PAR_TIME - 100) * POINTS.TIME_BONUS_PER_SECOND_UNDER_PAR);
});
check('wipeout retains earned events and chain bonuses but excludes every finish bonus', () => {
  const { player, score, emit } = rig();
  for (let i = 0; i < 10; i++) emit();
  const earned = score.runningScore;
  player.crashIntoTree();
  score.update(0);
  const result = score.finalize(false, 5_000, 1);
  assert.equal(result.finished, false);
  assert.equal(result.total, earned);
  assert.equal(result.completionBonus, 0);
  assert.equal(result.timeBonus, 0);
  assert.equal(result.positionBonus, 0);
  assert.equal(result.position, 1);
  assert.equal(result.eventTotal, categoryTotal(result));
});
check('all finishing positions use their proper bonuses; over-par time is never penalized', () => {
  const { score } = rig();
  [POINTS.POSITION_BONUS_FIRST, POINTS.POSITION_BONUS_SECOND, POINTS.POSITION_BONUS_THIRD,
    POINTS.POSITION_BONUS_FOURTH, POINTS.POSITION_BONUS_FIFTH].forEach((points, i) => {
    const result = score.finalize(true, (PAR_TIME + 20) * 1000, i + 1);
    assert.equal(result.positionBonus, points);
    assert.equal(result.timeBonus, 0);
    assert.equal(result.total, POINTS.COMPLETION_BONUS + points);
  });
});
check('standings prefer finish order, then live racers, then DNF progress', () => {
  const player = new Player();
  player.worldZ = 5000;
  const early = rider(0, 10_000); early.finishTimeMs = 10_000;
  const late = rider(1, 10_000); late.finishTimeMs = 12_000;
  const active = rider(3, 4500);
  const out = rider(4, 9000); out.crashIntoTree();
  const riders = [early, late, active, out];
  assert.equal(computePlayerPosition(player, riders, 11_000), 2);
  assert.equal(computePlayerPosition(player, riders, null), 3);
  player.crashIntoTree();
  assert.equal(computePlayerPosition(player, riders, null), 5);
});
check('real deliberate combat preserves charge cost, base hit score and subsequent knockout', () => {
  const rival = rider(3, 1200);
  const { player, combat, score } = rig([], [rival]);
  player.armWeapon();
  rival.speed = MAX_SPEED / 2;
  combat.update(0, 1000);
  assert.equal(combat.attemptAttack(1000), true);
  assert.equal(player.weaponCharges, WEAPON_CHARGES - 1);
  score.update(0);
  assert.equal(score.runningScore, POINTS.COMBAT_HIT);
  assert.equal(score.feedback[0].kind, 'hit');
  assert.equal(player.swinging, true);
  rival.crashIntoTree();
  combat.update(16, 1016);
  score.update(16);
  assert.equal(score.runningScore, POINTS.COMBAT_HIT + POINTS.KNOCKOUT);
  assert.equal(score.feedback[0].kind, 'knockout');
});
check('real passive contact remains a fifth-value brush and spends no pole charge', () => {
  const rival = rider(2, 1200);
  const { player, combat, score } = rig([], [rival]);
  player.armWeapon();
  rival.speed = MAX_SPEED / 2;
  combat.update(0, 1000);
  score.update(0);
  assert.equal(player.weaponCharges, WEAPON_CHARGES);
  assert.equal(score.runningScore, POINTS.COMBAT_BRUSH);
  assert.equal(POINTS.COMBAT_BRUSH, POINTS.COMBAT_HIT / 5);
  assert.equal(score.feedback[0].kind, 'brush');
  assert.equal(player.swinging, false);
});
console.log(`\n=== ${passed} scoring checks passed; ${failed} failed ===\n`);
if (failed) process.exitCode = 1;
