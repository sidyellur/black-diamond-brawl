import assert from 'node:assert/strict';
import { MAX_SPEED, SEGMENT_LENGTH, SHOVE_SPEED_LOSS_FACTOR } from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { CombatSystem } from '../src/entities/combat';
import { Player } from '../src/entities/player';
import { PERSONALITIES } from '../src/entities/personality';
import { COUNTER_WINDOW_MS, RivalAttack } from '../src/entities/skillCombat';
import type { Obstacle } from '../src/entities/obstacle';

let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }

function world(obstacles: Obstacle[] = []) {
  const player = new Player();
  player.speed = MAX_SPEED;
  player.worldZ = 10000;
  const rider = new AIRider({ cruiseSpeedFactor: 1, aggression: 0,
    reactionDistanceSegments: 8, startLane: 1, startZOffset: 10100,
    paletteIndex: 0, personality: 'bully', behaviorSeed: 42 });
  rider.speed = MAX_SPEED;
  const combat = new CombatSystem(player, [rider], obstacles);
  let now = 0;
  function step(ms = 20): void {
    now += ms;
    player.update(ms); rider.update(ms, obstacles, player); combat.update(ms, now);
  }
  function advance(ms: number): void { for (let left = ms; left > 0; left -= 20) step(Math.min(left, 20)); }
  function tell(): void { assert.ok(rider.requestTelegraphedAttack(player)); }
  return { player, rider, combat, step, advance, tell, now: () => now };
}
const windup = PERSONALITIES.bully.windupMs;

console.log('\n=== skill combat timing ===');
test('a rival attack advertises the complete wind-up before damage', () => {
  const w = world(); w.tell(); w.advance(windup - 20);
  assert.equal(w.rider.attackPhase, 'windup');
  assert.equal(w.player.speed, MAX_SPEED);
  assert.equal(w.combat.skillEvents.filter(e => e.type === 'windup').length, 1);
  assert.equal(w.combat.incomingAttack, w.rider);
  w.step();
  assert.equal(w.rider.attackPhase, 'strike');
  assert.equal(w.player.speed, MAX_SPEED * (1 - SHOVE_SPEED_LOSS_FACTOR));
  assert.equal(w.combat.skillEvents.filter(e => e.type === 'rival-hit').length, 1);
  w.advance(200);
  assert.equal(w.rider.attackPhase, 'recovery');
  assert.equal(w.combat.skillEvents.filter(e => e.type === 'rival-hit').length, 1);
  assert.equal(w.rider.requestTelegraphedAttack(w.player), false);
});

test('timed steering earns a useful target-specific counter, even at lower speed', () => {
  const w = world(); w.tell(); w.advance(windup - 180);
  w.player.requestLaneShift(1); w.advance(180);
  assert.equal(w.player.hitReacting, false);
  assert.equal(w.combat.counterReady, true);
  assert.equal(w.combat.target, w.rider);
  assert.equal(w.combat.skillEvents.find(e => e.type === 'evade')?.evade, 'steer');
  w.player.speed = 1000;
  assert.ok(w.combat.attemptAttack(w.now()));
  assert.equal(w.rider.speed, MAX_SPEED * 0.6);
  assert.equal(w.combat.events.filter(e => e.type === 'hit').length, 1);
  assert.equal(w.combat.skillEvents.filter(e => e.type === 'counter').length, 1);
  assert.equal(w.combat.counterReady, false);
  assert.equal(w.combat.attemptAttack(w.now()), false);
});

test('timed jump can counter immediately in the air without an extra button', () => {
  const w = world(); w.tell(); w.advance(windup - 140);
  w.player.jump(false); w.advance(140);
  assert.equal(w.player.airborne, true);
  assert.equal(w.combat.counterReady, true);
  assert.equal(w.combat.skillEvents.find(e => e.type === 'evade')?.evade, 'jump');
  w.player.armWeapon(); const charges = w.player.weaponCharges;
  assert.ok(w.combat.attemptAttack(w.now()));
  assert.equal(w.player.weaponCharges, charges, 'earned counter does not spend a pole charge');
  assert.equal(w.combat.skillEvents.filter(e => e.type === 'counter').length, 1);
});

test('early jump escapes the attack but does not earn a timed counter', () => {
  const w = world(); w.tell(); w.advance(160);
  w.player.jump(false); w.advance(windup - 160);
  assert.equal(w.player.airborne, true);
  assert.equal(w.player.hitReacting, false);
  assert.equal(w.combat.counterReady, false);
  assert.equal(w.combat.skillEvents.filter(e => e.type === 'whiff').length, 1);
});

test('early steering is safe, but gives no counter; late steering still gets hit', () => {
  const early = world(); early.tell(); early.player.requestLaneShift(1); early.advance(windup);
  assert.equal(early.combat.counterReady, false);
  assert.equal(early.player.hitReacting, false);
  const late = world(); late.tell(); late.advance(windup - 20);
  late.player.requestLaneShift(1); late.step();
  assert.equal(late.combat.counterReady, false);
  assert.equal(late.player.hitReacting, true);
});

test('an automatic crest launch does not grant an earned evade', () => {
  const w = world(); w.tell(); w.advance(windup - 100);
  w.player.jump(true, false); w.advance(100);
  assert.equal(w.combat.counterReady, false);
  assert.equal(w.player.hitReacting, false);
});

test('counter expires using simulation time and cannot be renewed by mashing', () => {
  const w = world(); w.tell(); w.advance(windup - 140); w.player.jump(false); w.advance(140);
  assert.equal(w.combat.counterFraction, 1);
  w.combat.update(COUNTER_WINDOW_MS - 1, 999999);
  assert.ok(w.combat.counterFraction > 0, 'wall-clock does not expire it');
  w.combat.update(1, 9999999);
  assert.equal(w.combat.counterTarget, null);
  assert.equal(w.combat.attemptAttack(w.now()), false, 'still airborne without a counter');
});

test('hitting or tumbling a rival cancels its pending strike', () => {
  const hit = world(); hit.tell(); hit.advance(200);
  assert.ok(hit.combat.attemptAttack(hit.now()));
  assert.equal(hit.rider.attackPhase, 'recovery');
  hit.advance(windup);
  assert.equal(hit.combat.skillEvents.some(e => e.type === 'rival-hit'), false);
  const rock = world(); rock.tell(); rock.advance(200); rock.rider.hitRock(); rock.advance(windup);
  assert.equal(rock.combat.skillEvents.some(e => e.type === 'rival-hit'), false);
});

test('player tumble, finish and wipeout invalidate counters and incoming strikes', () => {
  const w = world(); w.tell(); w.advance(windup - 140); w.player.jump(false); w.advance(140);
  w.player.hitRock(); w.combat.update(20, w.now() + 20);
  assert.equal(w.combat.counterReady, false);
  const finished = world(); finished.tell(); finished.rider.finishTimeMs = 100; finished.advance(windup);
  assert.equal(finished.combat.skillEvents.some(e => e.type === 'rival-hit'), false);
  const crashed = world(); crashed.tell(); crashed.rider.crashIntoTree(); crashed.advance(windup);
  assert.equal(crashed.player.hitReacting, false);
});

test('counter knockback retains crossed-tree and road-edge safety', () => {
  const obstacles: Obstacle[] = [{ kind: 'tree', lane: 0, z: 12200, segIndex: 61 }];
  const w = world(obstacles); w.tell(); w.advance(windup - 180);
  w.player.requestLaneShift(1); w.advance(180);
  assert.ok(w.combat.attemptAttack(w.now()));
  // Counter from lane3 would knock lane1 towards lane0, which has a tree.
  assert.equal(w.rider.leanDirection, 0);
  assert.equal(w.rider.laneIndex, 1);
  assert.ok(w.rider.speed > 0);
  assert.equal(w.combat.events.filter(e => e.type === 'hit').length, 1);
});

test('a counter never retargets to an unrelated nearby rival', () => {
  const w = world(); w.tell(); w.advance(windup - 140); w.player.jump(false); w.advance(140);
  w.rider.worldZ += SEGMENT_LENGTH * 10;
  assert.equal(w.combat.counterReady, false);
  assert.equal(w.combat.attemptAttack(w.now()), false);
  assert.equal(w.combat.skillEvents.some(e => e.type === 'counter'), false);
});

test('the attack timer latches a skipped strike once and recovery blocks restart', () => {
  const attack = new RivalAttack(); assert.ok(attack.begin(0, false, 640, 1050));
  attack.update(1000); assert.equal(attack.phase, 'recovery');
  assert.equal(attack.takeStrike()?.ageMs, 360);
  assert.equal(attack.takeStrike(), null);
  assert.equal(attack.begin(0, false, 640, 1050), false);
  attack.update(1000); assert.equal(attack.phase, 'idle');
  assert.ok(attack.begin(0, false, 640, 1050)); attack.interrupt(); attack.update(1000);
  assert.equal(attack.takeStrike(), null);
});

test('production same-lane incoming contact also has a tell instead of surprise damage', () => {
  const player = new Player(); player.speed = 1000;
  const rider = new AIRider({ cruiseSpeedFactor: 1, aggression: 0, startLane: 2,
    startZOffset: player.worldZ, paletteIndex: 0, reactionDistanceSegments: 8, personality: 'bully' });
  rider.speed = 2000;
  const combat = new CombatSystem(player, [rider], []);
  combat.update(20, 20);
  assert.equal(player.speed, 1000);
  assert.equal(rider.attackPhase, 'windup');
  assert.equal(combat.skillEvents.filter(e => e.type === 'windup').length, 1);
});

console.log(`\n${passed} skill combat checks passed.\n`);
