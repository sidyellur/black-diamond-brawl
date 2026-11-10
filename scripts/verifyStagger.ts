/**
 * Rival stagger and knockdowns: pips per hit type, decay, the knockdown state,
 * targeting, wind-up cancellation, single knockout payment, finish-line cases
 * and determinism. Headless, through the real AIRider / CombatSystem /
 * CollisionSystem / ScoreTracker.
 */
import assert from 'node:assert/strict';
import {
  ATTACK_COOLDOWN_MS, KNOCKDOWN_IMMUNITY_MS, KNOCKDOWN_MS, KNOCKOUT_WINDOW_MS, MAX_SPEED, PLAYER_ACCEL, SEGMENT_LENGTH,
  STAGGER_DECAY_MS, STAGGER_MAX
} from '../src/config';
import { AIRider, type AIRiderParams } from '../src/entities/aiRider';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { PERSONALITIES } from '../src/entities/personality';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';

const STEP = 1000 / 60;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const steps = (ms: number) => Math.round(ms / STEP);
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

/** Legacy untyped rival (no personality): passive contact resolves as a plain
 * speed exchange, which is what a brush test needs. */
const rider = (over: Partial<AIRiderParams> = {}) => new AIRider({
  cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 3, startZOffset: 10_000, paletteIndex: 0, ...over
});
function world(over: Partial<AIRiderParams> = {}, obstacles: Obstacle[] = []) {
  setDeterministicRuntime(7);
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
  const r = rider(over); r.speed = MAX_SPEED * 0.5;
  const combat = new CombatSystem(player, [r], obstacles);
  let now = 1000;
  const step = (ms = STEP) => { now += ms; player.update(ms); r.update(ms, obstacles, player); combat.update(ms, now); };
  const advance = (ms: number) => { for (let i = 0; i < steps(ms); i++) step(); };
  const knockouts = () => combat.events.filter(e => e.type === 'knockout').length;
  if (over.startLane !== 2) combat.update(STEP, now); // pick the attack target
  return { player, r, combat, step, advance, knockouts, now: () => now };
}
const typed = { personality: 'bully' as const, behaviorSeed: 42 };

console.log('\n=== rival stagger and knockdowns ===');

test('config: three pips, 6s decay, 2.5s down, 1.5s immunity', () => {
  assert.equal(STAGGER_MAX, 3); assert.equal(STAGGER_DECAY_MS, 6000);
  assert.equal(KNOCKDOWN_MS, 2500); assert.equal(KNOCKDOWN_IMMUNITY_MS, 1500);
});

test('pips: unarmed hit 1, pole hit 2, counter 2, passive brush 0', () => {
  { const w = world(); assert.equal(w.combat.attemptAttack(w.now()), true);
    assert.equal(w.r.stagger, 1); assert.equal(w.knockouts(), 0); }
  { const w = world(); w.player.armWeapon(); assert.equal(w.combat.attemptAttack(w.now()), true);
    assert.equal(w.r.stagger, 2); assert.equal(w.knockouts(), 0); }
  { // a pole swing against a FASTER rival still counts the pole's 2
    const w = world(); w.r.speed = MAX_SPEED * 1.2; w.player.armWeapon();
    assert.equal(w.combat.attemptAttack(w.now()), true); assert.equal(w.r.stagger, 2); }
  { // passive body check: a brush event, no pips
    const w = world({ startLane: 2 }); w.combat.update(STEP, w.now());
    assert.equal(w.combat.events.filter(e => e.type === 'brush').length, 1, 'the contact is a brush');
    assert.equal(w.r.stagger, 0); assert.equal(w.combat.events.length, 1); }
  { // counter: a faster rival, evaded, then countered
    const w = world(typed, []); w.r.speed = MAX_SPEED; w.r.worldZ = 10_100;
    assert.ok(w.r.requestTelegraphedAttack(w.player));
    const windup = PERSONALITIES.bully.windupMs;
    w.advance(windup - 180); w.player.requestLaneShift(1); w.advance(180);
    assert.equal(w.combat.counterReady, true);
    w.player.speed = 1000; // slower than the rival: only a counter can win
    assert.equal(w.combat.attemptAttack(w.now()), true);
    assert.equal(w.r.stagger, 2, 'a counter adds two pips'); assert.equal(w.r.knockedDown, false,
      'one counter does not knock the practice trainer down'); }
});

test('decay: one pip per 6s without a hit; a hit restarts the clock', () => {
  const player = new Player(); const r = rider();
  r.addStagger(2);
  for (let i = 0; i < steps(STAGGER_DECAY_MS) - 2; i++) r.update(STEP, [], player);
  assert.equal(r.stagger, 2, 'nothing recovered before 6s');
  r.update(STEP, [], player); r.update(STEP, [], player);
  assert.equal(r.stagger, 1, 'first pip recovered at 6s');
  for (let i = 0; i < steps(STAGGER_DECAY_MS) + 2; i++) r.update(STEP, [], player);
  assert.equal(r.stagger, 0, 'second pip a further 6s later');
  r.addStagger(1);
  for (let i = 0; i < steps(5000); i++) r.update(STEP, [], player);
  r.addStagger(1); // 5s in: restarts the timer
  for (let i = 0; i < steps(5000); i++) r.update(STEP, [], player);
  assert.equal(r.stagger, 2, 'a fresh hit at 5s means no recovery by 10s');
  for (let i = 0; i < steps(1500); i++) r.update(STEP, [], player);
  assert.equal(r.stagger, 1);
});

test('knockdown: the third pip stops the rival for 2.5s, then 1.5s of immunity, empty meter, not a tree strike', () => {
  const player = new Player(); const r = rider(); r.worldZ = 5000; r.speed = MAX_SPEED;
  assert.equal(r.addStagger(2), false);
  assert.equal(r.addStagger(1), true);
  assert.equal(r.knockedDown, true); assert.equal(r.stagger, 0); assert.equal(r.speed, 0);
  assert.equal(r.collisionImmune, true); assert.equal(r.tumbling, true);
  assert.equal(r.wipedOut, false); assert.equal(r.treeStrikes, 0); assert.equal(r.treeCrashSerial, 0);
  assert.equal(r.heavyCrashing, false, 'a knockdown is not a tree crash');
  const z0 = r.worldZ;
  for (let i = 0; i < steps(KNOCKDOWN_MS) - 1; i++) {
    r.update(STEP, [], player);
    assert.equal(r.speed, 0); assert.equal(r.worldZ, z0); assert.equal(r.knockedDown, true);
    assert.equal(r.collisionImmune, true);
  }
  r.update(STEP, [], player); r.update(STEP, [], player); r.update(STEP, [], player); // float slack
  assert.equal(r.knockedDown, false); assert.ok(r.speed > 0 && r.speed < PLAYER_ACCEL * 0.1, 'getting up, accelerating');
  assert.equal(r.collisionImmune, true, 'still immune after standing');
  let t = KNOCKDOWN_MS;
  while (r.collisionImmune && t < 10_000) { r.update(STEP, [], player); t += STEP; }
  near(t, KNOCKDOWN_MS + KNOCKDOWN_IMMUNITY_MS, STEP * 3);
  assert.equal(r.stagger, 0); assert.equal(r.treeStrikes, 0); assert.equal(r.treeCrashSerial, 0);
  assert.equal(r.addStagger(1), false, 'cannot be staggered while down or immune');
  // a heavy overshoot of pips is clamped into a single knockdown
  const r2 = rider(); r2.addStagger(2); assert.equal(r2.addStagger(2), true); assert.equal(r2.stagger, 0);
});

test('knockdown: cannot steer, attack or be hit; hits during it do nothing', () => {
  const w = world({ ...typed, aggression: 1 }); w.r.speed = MAX_SPEED;
  w.r.addStagger(3);
  const lane = w.r.laneIndex;
  const speedBefore = w.player.speed;
  for (let i = 0; i < steps(KNOCKDOWN_MS) - 2; i++) {
    w.step();
    assert.equal(w.r.attackPhase, 'idle'); assert.equal(w.r.laneIndex, lane);
    assert.equal(w.r.requestTelegraphedAttack(w.player), false);
    assert.equal(w.r.speed, 0);
  }
  assert.equal(w.player.speed, speedBefore, 'a downed rival never struck the player');
});

test('knockdown: untargetable, rides through, targetable again after the immunity', () => {
  const w = world(); w.r.addStagger(3);
  let steps_ = 0;
  while (w.r.collisionImmune && steps_++ < 1000) {
    w.player.worldZ = w.r.worldZ - 20; // stay in reach the whole time
    w.player.speed = MAX_SPEED;
    w.step();
    if (!w.r.collisionImmune) break;
    assert.equal(w.combat.target, null, 'no marker on a downed rival');
    assert.equal(w.combat.attemptAttack(w.now()), false);
  }
  near(steps_ * STEP, KNOCKDOWN_MS + KNOCKDOWN_IMMUNITY_MS, STEP * 3);
  assert.equal(w.combat.events.length, 0, 'no hit, brush or knockout from riding through a downed rival');
  assert.equal(w.r.stagger, 0);
  for (let i = 0; i < 60; i++) { w.player.worldZ = w.r.worldZ - 20; w.r.speed = MAX_SPEED * 0.5; w.step(); }
  assert.equal(w.combat.target, w.r, 'targetable again once the immunity is over');
  assert.equal(w.combat.attemptAttack(w.now()), true);
  assert.equal(w.r.stagger, 1);
});

test('knockdown cancels an in-progress wind-up and the strike never lands', () => {
  const w = world(typed); w.r.speed = MAX_SPEED;
  assert.ok(w.r.requestTelegraphedAttack(w.player));
  w.advance(150); assert.equal(w.r.attackPhase, 'windup');
  assert.equal(w.r.addStagger(3), true);
  assert.equal(w.r.attackPhase, 'idle'); assert.equal(w.r.consumeStrike(), null);
  const speed = w.player.speed;
  w.advance(PERSONALITIES.bully.windupMs + 600);
  assert.equal(w.player.speed, speed); assert.equal(w.combat.skillEvents.filter(e => e.type === 'rival-hit').length, 0);
});

test('knockdown preserves the setback (no catch-up for the bounded grace)', () => {
  const player = new Player(); player.worldZ = 500_000; player.speed = MAX_SPEED;
  const r = rider(); r.worldZ = 0; r.speed = MAX_SPEED; r.addStagger(3);
  let peak = 0, t = 0;
  for (; t < 3900; t += STEP) { r.update(STEP, [], player); peak = Math.max(peak, r.speed); }
  assert.ok(peak <= MAX_SPEED + 1e-6, `no catch-up inside the grace: ${peak}`);
  for (; t < 9000; t += STEP) { r.update(STEP, [], player); peak = Math.max(peak, r.speed); }
  assert.ok(peak > MAX_SPEED, 'catch-up resumes afterwards');
});

test('knockout payment: a knockdown pays exactly one knockout (hit + knockout, never two)', () => {
  const w = world(); w.r.addStagger(2);
  assert.equal(w.combat.attemptAttack(w.now()), true);
  assert.equal(w.r.knockedDown, true);
  assert.equal(w.knockouts(), 1);
  assert.equal(w.combat.events.filter(e => e.type === 'hit').length, 1);
  const score = new ScoreTracker(w.player, [w.r], [], new CollisionSystem(), w.combat);
  score.update(0);
  const ko = score.feedback.find(e => e.kind === 'knockout')!;
  assert.equal(ko.label, 'KNOCKOUT · BULLY');
  assert.equal(score.finalize(false, 9000, 1).knockoutCount, 1, 'the result screen counts the knockdown');
});

test('knockout payment: no second payment from any tree path in the same incident', () => {
  // (a) A tree sitting right where the downed rival lies: it is immune, so the
  // collision system never crashes it, and nothing more is paid.
  const trees: Obstacle[] = [{ kind: 'tree', lane: 4, z: 10_000, segIndex: 50 }];
  const w = world({}, trees); w.r.addStagger(2);
  assert.equal(w.combat.attemptAttack(w.now()), true); assert.equal(w.knockouts(), 1);
  w.combat.events.length = 0;
  const cs = new CollisionSystem();
  for (let i = 0; i < steps(KNOCKDOWN_MS + KNOCKDOWN_IMMUNITY_MS); i++) {
    w.step(); cs.update(w.r, trees);
  }
  assert.equal(w.r.treeStrikes, 0, 'a downed rival never touches the tree'); assert.equal(w.knockouts(), 0);
  // (b) Even a forced tree crash inside the window is not credited again.
  const f = world(); f.r.addStagger(2); f.combat.attemptAttack(f.now());
  assert.equal(f.knockouts(), 1); f.combat.events.length = 0;
  f.r.crashIntoTree(); f.step();
  assert.equal(f.knockouts(), 0, 'the knockdown spent the shove credit');
  // (c) The reverse: a tree knockout pays once and a second contact in its window pays nothing.
  const g = world(); g.combat.attemptAttack(g.now()); g.combat.events.length = 0;
  g.r.crashIntoTree(); g.step();
  assert.equal(g.knockouts(), 1); g.combat.events.length = 0;
  g.r.crashIntoTree(); g.step();
  assert.equal(g.knockouts(), 0, 'one knockout per incident');
  // (d) A new hit after the immunity is a new incident and can pay again.
  const h = world(); h.r.addStagger(2); h.combat.attemptAttack(h.now()); assert.equal(h.knockouts(), 1);
  h.combat.events.length = 0;
  h.advance(KNOCKDOWN_MS + KNOCKDOWN_IMMUNITY_MS + ATTACK_COOLDOWN_MS + 200);
  h.r.speed = MAX_SPEED * 0.5; h.player.worldZ = h.r.worldZ - 10;
  h.combat.update(STEP, h.now() + 5000);
  assert.equal(h.combat.attemptAttack(h.now() + 5000), true);
  assert.equal(h.r.stagger, 1); assert.equal(h.knockouts(), 0, 'one pip is a hit, not a knockout');
});

test('knockout payment: shoving a rival into a tree still pays the single tree knockout', () => {
  const w = world(); assert.equal(w.combat.attemptAttack(w.now()), true);
  assert.equal(w.knockouts(), 0); w.combat.events.length = 0;
  w.r.crashIntoTree(); w.step();
  assert.equal(w.knockouts(), 1);
  assert.equal(w.r.stagger, 1, 'the earlier pip is untouched by a tree');
  assert.equal(w.r.knockedDown, false);
});

test('finish line: a finished rival cannot be staggered, targeted or hit', () => {
  const w = world(); w.r.finishTimeMs = 50_000;
  assert.equal(w.r.addStagger(3), false); assert.equal(w.r.stagger, 0); assert.equal(w.r.knockedDown, false);
  assert.equal(w.combat.attemptAttack(w.now()), false);
  w.r.update(STEP, [], w.player); assert.equal(w.r.knockedDown, false);
});

test('finish line: a rival knocked down just before the line still finishes', () => {
  const finishZ = 100_000;
  for (const ahead of [1500, 400, 20]) {
    const player = new Player(); player.worldZ = 50_000;
    const r = rider({ cruiseSpeedFactor: 1 }); r.worldZ = finishZ - ahead; r.speed = MAX_SPEED;
    assert.equal(r.addStagger(3), true);
    let t = 0;
    for (; t < 20_000 && r.finishTimeMs === null; t += STEP) {
      r.update(STEP, [], player);
      if (r.finishTimeMs === null && r.worldZ >= finishZ) r.finishTimeMs = t;
      if (r.finishTimeMs !== null) r.worldZ = finishZ;
    }
    assert.notEqual(r.finishTimeMs, null, `${ahead} units out: finishes`);
    assert.equal(r.wipedOut, false);
    assert.ok(t >= KNOCKDOWN_MS - STEP * 2, `${ahead} units out: lost the whole ${KNOCKDOWN_MS}ms (${t.toFixed(0)})`);
    assert.equal(r.addStagger(3), false, 'a finisher cannot be put down again');
  }
});

test('hit spacing: three unarmed hits need at least two attack cooldowns of sustained contact', () => {
  const w = world(); const times: number[] = [];
    for (let i = 0; i < steps(8000) && !w.r.knockedDown; i++) {
    w.r.speed = MAX_SPEED * 0.5; w.player.worldZ = w.r.worldZ - 10;
    if (!w.player.swinging && w.player.laneIndex !== w.r.laneIndex) w.player.requestLaneShift(w.r.laneIndex > w.player.laneIndex ? 1 : -1);
    if (w.combat.attemptAttack(w.now())) times.push(w.now());
    w.step(); w.combat.events.length = 0;
  }
  assert.equal(times.length, 3); assert.equal(w.r.knockedDown, true);
  assert.ok(times[2] - times[0] >= 2 * ATTACK_COOLDOWN_MS - STEP, `spacing ${times[2] - times[0]}ms`);
  assert.ok(times[2] - times[0] >= 1200 && times[2] - times[0] < STAGGER_DECAY_MS, 'inside the decay window');
});

/** Scripted attacker that follows the rival's lane and attacks whenever the
 * game would allow it. `plan` decides when the pole is armed. */
function chase(factor: number, startDz: number, plan: 'pole-first' | 'unarmed-then-pole' | 'unarmed') {
  setDeterministicRuntime(3);
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
  const r = rider({ cruiseSpeedFactor: factor, ...typed, startLane: 2, startZOffset: 10_000 + startDz });
  r.speed = MAX_SPEED * factor;
  const combat = new CombatSystem(player, [r], []);
  if (plan === 'pole-first') player.armWeapon();
  const hits: number[] = []; let down: number | null = null;
  for (let t = 0; t < 20_000 && down === null; t += STEP) {
    if (!player.swinging && !player.hitReacting && player.laneIndex !== r.laneIndex) {
      player.requestLaneShift(r.laneIndex > player.laneIndex ? 1 : -1);
    }
    if (plan === 'unarmed-then-pole' && hits.length === 1 && !player.armed) player.armWeapon();
    if (combat.attemptAttack(t)) hits.push(Math.round(t));
    player.update(STEP); r.update(STEP, [], player); combat.update(STEP, t);
    if (combat.events.some(e => e.type === 'knockout')) down = Math.round(t);
    combat.events.length = 0;
  }
  return { hits, down, stagger: r.stagger };
}

test('reachable but not trivial against 0.96-1.04x rivals', () => {
  // Slower rivals (and equal pace): an unarmed hit followed by a pole hit in the same pass.
  const slow = [chase(0.96, 500, 'unarmed-then-pole'), chase(0.98, 500, 'unarmed-then-pole')];
  for (const s of slow) { assert.notEqual(s.down, null, `knocked down: ${JSON.stringify(s)}`); assert.equal(s.hits.length, 2); }
  // Faster rivals beat an unarmed press, so it takes the pole, across two passes.
  const fast = [chase(1.02, -500, 'pole-first'), chase(1.04, -500, 'pole-first'), chase(1.04, 0, 'pole-first')];
  for (const f of fast) { assert.notEqual(f.down, null, `knocked down: ${JSON.stringify(f)}`); assert.equal(f.hits.length, 2); }
  // Not trivial: unarmed hits alone never reach three pips in one pass against a slower rival,
  // and an unarmed press cannot beat a faster one.
  for (const f of [0.96, 0.98, 1.0]) for (const dz of [-500, 0, 500]) {
    const u = chase(f, dz, 'unarmed'); assert.equal(u.down, null, `${f}x ${dz}: ${JSON.stringify(u)}`); }
  for (const f of [1.02, 1.04]) assert.equal(chase(f, 0, 'unarmed').down, null);
  const gaps = fast.map(f => f.hits[1] - f.hits[0]);
  console.log(`    (slow rivals: ${slow.map(s => s.hits.join('/')).join(', ')}ms; fast rivals' pole gaps ${gaps.join(', ')}ms; decay ${STAGGER_DECAY_MS}ms kept)`);
});

test('determinism: identical runs produce identical stagger traces', () => {
  const trace = () => {
    const w = world(typed); const out: string[] = [];
    for (let i = 0; i < steps(9000); i++) {
      w.r.speed = Math.min(w.r.speed, MAX_SPEED * 0.6); w.player.worldZ = w.r.worldZ - 10;
      if (i % 40 === 0) w.combat.attemptAttack(w.now());
      w.step(); w.combat.events.length = 0;
      out.push(`${w.r.stagger}|${w.r.knockdownMsRemaining.toFixed(2)}|${w.r.worldZ.toFixed(2)}|${w.r.attackPhase}`);
    }
    return out.join(',');
  };
  assert.equal(trace(), trace());
});

console.log(`\n${passed} stagger checks passed`);
