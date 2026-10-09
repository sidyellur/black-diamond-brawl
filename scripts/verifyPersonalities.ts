import assert from 'node:assert/strict';
import { MAX_SPEED, SEGMENT_LENGTH } from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { CombatSystem } from '../src/entities/combat';
import { CollisionSystem } from '../src/entities/collision';
import { Player } from '../src/entities/player';
import { PERSONALITIES, PERSONALITY_ORDER, type RivalPersonality } from '../src/entities/personality';
import type { Obstacle } from '../src/entities/obstacle';
import { generateTrack } from '../src/track/generator';
import { mulberry32 } from '../src/track/prng';
import { spawnAIRiders } from '../src/track/aiSpawn';

let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const obstacle = (kind: Obstacle['kind'], lane: number, z: number): Obstacle => ({ kind, lane, z, segIndex: Math.floor(z / SEGMENT_LENGTH) });
function rider(personality: RivalPersonality, startLane = 1, z = 10000): AIRider {
  const r = new AIRider({ cruiseSpeedFactor: 1, aggression: 1, reactionDistanceSegments: 8,
    startLane, startZOffset: z, paletteIndex: 0, personality, behaviorSeed: 42 });
  r.speed = MAX_SPEED;
  return r;
}
function player(lane = 3, z = 10000): Player {
  const p = new Player();
  p.applyKnockback(lane, 0); p.update(200); p.worldZ = z; p.speed = MAX_SPEED;
  return p;
}

console.log('\n=== deterministic rival personalities ===');
test('every seeded field contains bully, defender and daredevil, with independent stable streams', () => {
  const a = spawnAIRiders(mulberry32(77)); const b = spawnAIRiders(mulberry32(77));
  assert.deepEqual(a, b);
  assert.deepEqual(new Set(a.map(r => r.personality)), new Set(PERSONALITY_ORDER));
  assert.equal(new Set(a.map(r => r.behaviorSeed)).size, a.length);
  assert.notDeepEqual(a.map(r => r.behaviorSeed), spawnAIRiders(mulberry32(78)).map(r => r.behaviorSeed));
});

test('identical open terrain produces pursuit, line holding, and terrain holding decisions', () => {
  const p = player();
  const rivals = PERSONALITY_ORDER.map(type => rider(type));
  rivals.forEach(r => r.update(20, [], p));
  assert.equal(rivals[0].leanDirection, 1, 'bully pursues player');
  assert.equal(rivals[1].leanDirection, 0, 'defender holds its protected line');
  assert.equal(rivals[2].leanDirection, 0, 'daredevil does not blindly pursue');
});

test('daredevil seeks a safe mogul that the other personalities ignore', () => {
  const p = player(1, 14000);
  const mogul = obstacle('mogul', 2, 11400);
  const rivals = PERSONALITY_ORDER.map(type => rider(type));
  rivals.forEach(r => r.update(20, [mogul], p));
  assert.equal(rivals[0].leanDirection, 0);
  assert.equal(rivals[1].leanDirection, 0);
  assert.equal(rivals[2].leanDirection, 1);
});

test('defender returns to its own line after knockback; bully follows the player instead', () => {
  const p = player(4, 10000);
  const defender = rider('line-defender'); const bully = rider('bully');
  defender.applyKnockback(2, 0); bully.applyKnockback(2, 0);
  defender.update(150, [], p); bully.update(150, [], p);
  assert.equal(defender.leanDirection, -1);
  assert.equal(bully.leanDirection, 1);
});

test('defender refuses pursuit attacks outside the guarded lane', () => {
  const p = player(2);
  const defender = rider('line-defender'); const bully = rider('bully');
  for (let t = 0; t < 1200; t += 20) {
    p.update(20); defender.update(20, [], p); bully.update(20, [], p);
  }
  assert.equal(defender.attackId, 0);
  assert.ok(bully.attackId > 0);
});

test('daredevil really jumps and clears both jumpable obstacle kinds', () => {
  for (const kind of ['rock', 'mogul'] as const) {
    const p = player(4, 14000); const r = rider('daredevil'); const collision = new CollisionSystem();
    const hazard = obstacle(kind, 1, 10800); let jumped = false;
    for (let t = 0; t < 700; t += 20) {
      r.update(20, [hazard], p); collision.update(r, [hazard]); jumped ||= r.airborne;
    }
    assert.equal(jumped, true, kind);
    assert.equal(collision.wasHit(hazard), false, kind);
    assert.ok(r.speed >= MAX_SPEED, kind);
  }
});

test('all archetypes avoid trees, and daredevil refuses a jump with a treed landing', () => {
  const p = player(4, 10000);
  for (const type of PERSONALITY_ORDER) {
    const r = rider(type); r.update(20, [obstacle('tree', 1, 11200)], p);
    assert.notEqual(r.leanDirection, 0, type);
  }
  const r = rider('daredevil');
  r.update(20, [obstacle('rock', 1, 10800), obstacle('tree', 1, 12000)], p);
  assert.equal(r.airborne, false);
  assert.notEqual(r.leanDirection, 0);
});

test('pursuit never steers into a blocked lane or off the road', () => {
  const p = player(3); const r = rider('bully');
  r.update(20, [obstacle('tree', 2, 10900)], p);
  assert.equal(r.leanDirection, 0);
  const edge = rider('line-defender', 0);
  edge.update(20, [obstacle('tree', 0, 10900)], p);
  assert.equal(edge.leanDirection, 1);
});

test('a tree warning cancels a committed strike rather than locking the AI into a crash', () => {
  const p = player(2); const r = rider('bully');
  assert.ok(r.requestTelegraphedAttack(p));
  r.update(20, [obstacle('tree', 1, 11000)], p);
  assert.equal(r.attackPhase, 'recovery');
  assert.notEqual(r.leanDirection, 0);
  r.update(1000, [], p);
  assert.equal(r.consumeStrike(), null);
});

test('aerial interaction uses jump heights; ordinary grounded attacks do not strike an airborne rival', () => {
  const p = player(1, 10000); const r = rider('daredevil', 1, 10000);
  const hazard = obstacle('mogul', 1, 10400);
  r.update(20, [hazard], p);
  assert.equal(r.airborne, true);
  const combat = new CombatSystem(p, [r], []); combat.update(20, 20);
  assert.equal(combat.target, null);
  assert.equal(combat.attemptAttack(20), false);
  p.jump(true); p.worldZ = r.worldZ;
  assert.ok(r.requestTelegraphedAttack(p));
  let sawAirHit = false;
  for (let t = 20; t <= PERSONALITIES.daredevil.windupMs; t += 20) {
    p.update(20); r.update(20, [], p); combat.update(20, t);
    sawAirHit ||= combat.skillEvents.some(e => e.type === 'rival-hit');
  }
  assert.equal(p.airborne, true);
  assert.equal(sawAirHit, true, 'matching airborne trajectories resolve a telegraphed air collision');
  assert.equal(p.hitReacting, true);
});

function replay(seed: number, perturb: boolean): string {
  const course = generateTrack(seed); const p = new Player();
  const rivals = course.aiRiders.map(params => new AIRider(params));
  const collisions = rivals.map(() => new CollisionSystem());
  const combat = new CombatSystem(p, rivals, course.obstacles);
  const unrelated = rider('bully', 0, 40000);
  const frames: string[] = [];
  for (let time = 20; time <= 16000; time += 20) {
    if (time % 1800 === 0) p.requestLaneShift(time % 3600 ? 1 : -1);
    if (time % 2300 === 0) p.jump(false);
    if (time % 700 === 0) combat.attemptAttack(time);
    p.update(20);
    if (perturb) { unrelated.update(20, [], p); Math.random(); Math.random(); }
    const order = perturb ? [...rivals].reverse() : rivals;
    for (const r of order) {
      r.update(20, course.obstacles, p);
      collisions[rivals.indexOf(r)].update(r, course.obstacles);
    }
    combat.update(20, time);
    frames.push(JSON.stringify([p.worldZ, p.speed, p.laneOffsetFraction,
      rivals.map(r => [r.worldZ, r.speed, r.laneOffsetFraction, r.airborne, r.attackPhase, r.attackId, r.wipedOut]),
      combat.events.map(e => e.type), combat.skillEvents.map(e => e.type)]));
    combat.events.length = 0; combat.skillEvents.length = 0;
  }
  return frames.join('\n');
}

test('identical inputs reproduce races independently of render RNG and rider update order', () => {
  for (const seed of [1, 42, 777]) assert.equal(replay(seed, false), replay(seed, true), `seed ${seed}`);
});

test('competitive simulation never calls runtime Math.random', () => {
  const original = Math.random;
  try { Math.random = () => { throw new Error('unseeded gameplay RNG'); }; replay(73, false); }
  finally { Math.random = original; }
});

console.log(`\n${passed} personality checks passed.\n`);
