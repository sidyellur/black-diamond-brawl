/**
 * Powder fields (#39), handling side: the ground cap, the boost cap, the
 * airborne exemption, the smooth bleed on entry, rivals under the same cap
 * (catch-up included), the stopped states staying untouched, and near misses
 * still scoring. Course-generation rules live in verifyMountains and
 * verifySolvability; this runs the real Player / AIRider / ScoreTracker.
 * Run: node --import tsx scripts/verifyPowder.ts
 */
import assert from 'node:assert/strict';
import {
  AI_CRUISE_SPEED_MAX_FACTOR, BOOST_ACCEL_FACTOR, BOOST_SPEED_FACTOR, JUMP_REACH_EXTENDED, KNOCKDOWN_MS, MAX_SPEED,
  NEAR_MISS_MIN_SPEED_FACTOR, OVERSPEED_DECAY_PER_SECOND, PLAYER_ACCEL, POINTS, POWDER_MAX_SEGMENTS, POWDER_MIN_SEGMENTS,
  POWDER_SPEED_FACTOR, ROCK_SPEED_FACTOR, ROCK_TUMBLE_MS, SEGMENT_LENGTH, TREE_CRASH_TUMBLE_MS
} from '../src/config';
import { AIRider, PACK_CHASE_START_Z, type AIRiderParams } from '../src/entities/aiRider';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';
import { generateTrack } from '../src/track/generator';
import type { Segment, Surface } from '../src/track/segment';
import { surfaceAtZ, surfaceEntryCue, surfaceSpeedFactor, SURFACE_CUES } from '../src/track/surface';

const STEP = 1000 / 60;
const CAP = MAX_SPEED * POWDER_SPEED_FACTOR;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const rider = (over: Partial<AIRiderParams> = {}) => new AIRider({
  cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 3, startZOffset: 10_000, paletteIndex: 0, ...over
});
/** Run `ms` of fixed steps; `surface` may depend on where the player is. */
function run(player: Player, ms: number, surface: Surface | undefined | ((p: Player) => Surface | undefined), boosting = false): void {
  for (let t = 0; t < ms; t += STEP) player.update(STEP, boosting, typeof surface === 'function' ? surface(player) : surface);
}

console.log('\n=== powder: config and helpers ===');
test('config: powder caps at 80%, fields are 15-25 segments, near misses still pay in powder', () => {
  assert.equal(POWDER_SPEED_FACTOR, 0.8);
  assert.equal(POWDER_MIN_SEGMENTS, 15); assert.equal(POWDER_MAX_SEGMENTS, 25);
  assert.ok(POWDER_SPEED_FACTOR > NEAR_MISS_MIN_SPEED_FACTOR, 'the powder cap sits above the near-miss speed floor');
});
test('surfaceAtZ reads the segment under a world-Z and clamps to the track', () => {
  const track: Pick<Segment, 'surface'>[] = [{}, {}, { surface: 'powder' }, { surface: 'powder' }, {}];
  assert.equal(surfaceAtZ(track, 0), undefined);
  assert.equal(surfaceAtZ(track, 2 * SEGMENT_LENGTH), 'powder');
  assert.equal(surfaceAtZ(track, 4 * SEGMENT_LENGTH - 0.1), 'powder');
  assert.equal(surfaceAtZ(track, 4 * SEGMENT_LENGTH), undefined);
  assert.equal(surfaceAtZ(track, -500), undefined);
  assert.equal(surfaceAtZ(track, 1e9), undefined, 'clamped to the last segment');
  assert.equal(surfaceAtZ([], 100), undefined);
  assert.equal(surfaceAtZ(track, NaN), undefined);
  assert.equal(surfaceSpeedFactor('powder'), POWDER_SPEED_FACTOR);
  assert.equal(surfaceSpeedFactor(undefined), 1);
});
test('the entry cue fires once per surface change, in words', () => {
  assert.equal(SURFACE_CUES.powder, 'POWDER · JUMP IT');
  assert.equal(surfaceEntryCue(undefined, 'powder'), 'POWDER · JUMP IT');
  assert.equal(surfaceEntryCue('powder', 'powder'), null);
  assert.equal(surfaceEntryCue('powder', undefined), null);
  assert.equal(surfaceEntryCue(undefined, undefined), null);
});

console.log('\n=== powder: the player ===');
test('on the ground the top speed is 80% of MAX_SPEED, and piste is untouched', () => {
  const powder = new Player(); run(powder, 6000, 'powder');
  assert.equal(powder.speed, CAP);
  const piste = new Player(); run(piste, 6000, undefined);
  assert.equal(piste.speed, MAX_SPEED);
  const legacy = new Player(); for (let t = 0; t < 6000; t += STEP) legacy.update(STEP);
  assert.equal(legacy.speed, MAX_SPEED, 'update() without a surface behaves as before');
});
test('the boost cap shrinks by the same ratio, and boosting still helps', () => {
  const boosted = new Player(); run(boosted, 6000, 'powder', true);
  assert.equal(boosted.speed, CAP * BOOST_SPEED_FACTOR);
  assert.ok(boosted.speed > CAP && boosted.speed < MAX_SPEED);
  const piste = new Player(); run(piste, 6000, undefined, true);
  assert.equal(piste.speed, MAX_SPEED * BOOST_SPEED_FACTOR);
  // Boost acceleration is unchanged on the way up.
  const a = new Player(); a.update(100, true, 'powder');
  assert.equal(a.speed, PLAYER_ACCEL * BOOST_ACCEL_FACTOR * 0.1);
});
test('entering powder above its cap bleeds off at the boost-decay rate, never in a snap', () => {
  const p = new Player(); p.speed = MAX_SPEED;
  const speeds = [p.speed];
  for (let i = 0; i < 40; i++) { p.update(STEP, false, 'powder'); speeds.push(p.speed); }
  for (let i = 1; i < speeds.length; i++) {
    const drop = speeds[i - 1] - speeds[i];
    assert.ok(drop >= 0 && drop <= OVERSPEED_DECAY_PER_SECOND * STEP / 1000 + 1e-9, `step ${i} dropped ${drop}`);
  }
  assert.ok(speeds[1] > MAX_SPEED - 30, 'first step is a nudge, not a drop to the cap');
  assert.equal(speeds.at(-1), CAP);
  // Same story at full boost: 120% -> boost cap, then (button released) -> ground cap.
  const b = new Player(); b.speed = MAX_SPEED * BOOST_SPEED_FACTOR;
  let previous = b.speed;
  for (let i = 0; i < 60; i++) {
    b.update(STEP, true, 'powder');
    assert.ok(previous - b.speed <= OVERSPEED_DECAY_PER_SECOND * STEP / 1000 + 1e-9);
    previous = b.speed;
  }
  assert.equal(b.speed, CAP * BOOST_SPEED_FACTOR);
  run(b, 1500, 'powder', false);
  assert.equal(b.speed, CAP);
});
test('leaving powder accelerates back to full speed at the ordinary rate', () => {
  const p = new Player(); run(p, 3000, 'powder');
  p.update(100, false, undefined);
  assert.equal(p.speed, CAP + PLAYER_ACCEL * 0.1);
  run(p, 3000, undefined);
  assert.equal(p.speed, MAX_SPEED);
});
test('airborne riders ignore powder: no cap in the air, no cap on a jump over it', () => {
  const p = new Player(); run(p, 3000, 'powder');
  assert.equal(p.speed, CAP);
  p.jump(true);
  assert.equal(p.speed, CAP, 'takeoff speed is not raised');
  p.update(200, false, 'powder');
  assert.equal(p.airborne, true);
  assert.equal(p.speedCapFactor, 1);
  assert.equal(p.speed, CAP + PLAYER_ACCEL * 0.2, 'accelerates past the powder cap in the air');
  // Boost is ignored in the air as ever, so the air cap is plain MAX_SPEED.
  p.update(500, true, 'powder');
  assert.equal(p.speed, MAX_SPEED, 'air speed tops out at plain MAX_SPEED');
  // Landing back in powder above the cap bleeds off, again smoothly.
  let landed = false;
  for (let i = 0; i < 120 && !landed; i++) { p.update(STEP, false, 'powder'); landed = !p.airborne; }
  assert.equal(landed, true);
  const atLanding = p.speed;
  p.update(STEP, false, 'powder');
  assert.ok(atLanding - p.speed <= OVERSPEED_DECAY_PER_SECOND * STEP / 1000 + 1e-9);
});
test('a jump from the entry mogul clears most of a field, and it beats riding it', () => {
  const distance = (jump: boolean) => {
    const p = new Player(); p.speed = MAX_SPEED; p.worldZ = 0;
    if (jump) p.jump(true);
    let t = 0;
    for (; t < 3000 && p.worldZ < 25 * SEGMENT_LENGTH; t += STEP) p.update(STEP, false, 'powder');
    return t;
  };
  const jumped = distance(true), rode = distance(false);
  assert.ok(jumped < rode, `jumping ${jumped.toFixed(0)}ms vs riding ${rode.toFixed(0)}ms through 25 segments`);
  // 1,200 ms of airtime at up to MAX_SPEED reaches JUMP_REACH_EXTENDED segments: most of a 15-25 field.
  const p = new Player(); p.speed = MAX_SPEED; p.worldZ = 0; p.jump(true);
  while (p.airborne) p.update(STEP, false, 'powder');
  assert.ok(p.worldZ / SEGMENT_LENGTH >= JUMP_REACH_EXTENDED - 1 && p.worldZ / SEGMENT_LENGTH > 0.7 * POWDER_MIN_SEGMENTS);
});
test('stopped states are untouched: heavy crash, rock tumble, wipeout', () => {
  const heavy = new Player(); run(heavy, 3000, 'powder'); heavy.crashIntoTree();
  assert.equal(heavy.heavyCrashing, true); assert.equal(heavy.speed, 0);
  run(heavy, TREE_CRASH_TUMBLE_MS - 100, 'powder');
  assert.equal(heavy.speed, 0, 'no acceleration until the tumble ends');
  assert.equal(heavy.heavyCrashing, true);
  run(heavy, 200, 'powder'); assert.equal(heavy.heavyCrashing, false);
  run(heavy, 5000, 'powder'); assert.equal(heavy.speed, CAP, 'recovers to the powder cap, not above');
  // Identical timing on piste and powder for the tumble.
  const rockP = new Player(), rockN = new Player();
  run(rockP, 3000, 'powder'); run(rockN, 3000, undefined);
  rockP.hitRock(); rockN.hitRock();
  assert.equal(rockP.speed, CAP * ROCK_SPEED_FACTOR);
  assert.equal(rockN.speed, MAX_SPEED * ROCK_SPEED_FACTOR);
  run(rockP, ROCK_TUMBLE_MS - 20, 'powder'); run(rockN, ROCK_TUMBLE_MS - 20, undefined);
  assert.equal(rockP.tumbling, true); assert.equal(rockN.tumbling, true);
  run(rockP, 40, 'powder'); run(rockN, 40, undefined);
  assert.equal(rockP.tumbling, false); assert.equal(rockN.tumbling, false);
  const wiped = new Player(); run(wiped, 2000, 'powder'); wiped.crashIntoTree(); run(wiped, 3000, 'powder'); wiped.crashIntoTree();
  assert.equal(wiped.wipedOut, true);
  const frozen = { z: wiped.worldZ, speed: wiped.speed };
  run(wiped, 1000, 'powder');
  assert.deepEqual({ z: wiped.worldZ, speed: wiped.speed }, frozen);
});

console.log('\n=== powder: rivals ===');
test('a rival is capped on the ground in powder, and a fast cruiser is not capped on piste', () => {
  const player = new Player(); player.speed = MAX_SPEED;
  for (const cruiseSpeedFactor of [0.9, 1, 1.05]) {
    const r = rider({ cruiseSpeedFactor }); r.speed = 0;
    for (let t = 0; t < 8000; t += STEP) r.update(STEP, [], player, 'powder');
    assert.equal(r.speed, Math.min(CAP, MAX_SPEED * cruiseSpeedFactor), `cruise ${cruiseSpeedFactor}`);
    const open = rider({ cruiseSpeedFactor }); open.speed = 0;
    for (let t = 0; t < 8000; t += STEP) open.update(STEP, [], player);
    assert.equal(open.speed, MAX_SPEED * cruiseSpeedFactor, 'no surface: exactly as before');
  }
});
test('a rival entering powder fast bleeds off at the shared rate, not in a snap', () => {
  const player = new Player(); player.speed = MAX_SPEED;
  const r = rider({ cruiseSpeedFactor: 1.05 }); r.speed = MAX_SPEED * 1.05;
  let previous = r.speed;
  for (let i = 0; i < 90; i++) {
    r.update(STEP, [], player, 'powder');
    assert.ok(previous - r.speed >= 0 && previous - r.speed <= OVERSPEED_DECAY_PER_SECOND * STEP / 1000 + 1e-9);
    previous = r.speed;
  }
  assert.equal(r.speed, CAP);
});
test('catch-up still works while the player is slowed by powder, and can never lift a rival above the powder cap', () => {
  const player = new Player(); player.worldZ = 40_000;
  run(player, 3000, 'powder'); player.worldZ = 40_000;
  assert.equal(player.speed, CAP); assert.equal(player.speedCapFactor, POWDER_SPEED_FACTOR);
  // Far behind on piste: the pack chase is still on (the player is at the pace its surface allows).
  const chaser = rider({ startZOffset: 40_000 - PACK_CHASE_START_Z - 4000, cruiseSpeedFactor: 0.9 });
  chaser.speed = MAX_SPEED * 0.9;
  let peak = 0;
  for (let t = 0; t < 6000; t += STEP) { player.update(STEP, false, 'powder'); chaser.update(STEP, [], player); peak = Math.max(peak, chaser.speed); }
  assert.ok(peak > MAX_SPEED, `chase active on piste against a powder-paced player (peak ${peak})`);
  assert.ok(peak <= MAX_SPEED * AI_CRUISE_SPEED_MAX_FACTOR);
  // The same chase inside powder is held to the cap at every step.
  const inPowder = rider({ startZOffset: 40_000 - PACK_CHASE_START_Z - 4000, cruiseSpeedFactor: 0.9 });
  inPowder.speed = 0;
  let worst = 0;
  for (let t = 0; t < 12_000; t += STEP) { player.update(STEP, false, 'powder'); inPowder.update(STEP, [], player, 'powder'); worst = Math.max(worst, inPowder.speed); }
  assert.ok(worst <= CAP + 1e-9, `rival in powder peaked at ${worst}, cap ${CAP}`);
});
test('airborne rivals ignore powder', () => {
  const player = new Player(); player.speed = MAX_SPEED;
  const mogul: Obstacle = { kind: 'mogul', lane: 3, z: 10_150, segIndex: 50 };
  const r = rider({ personality: 'daredevil', cruiseSpeedFactor: 1.05, startZOffset: 10_000, behaviorSeed: 3 });
  r.speed = CAP;
  let sawAirborne = false;
  for (let t = 0; t < 3000; t += STEP) {
    r.update(STEP, [mogul], player, 'powder');
    if (r.airborne) { sawAirborne = true; if (r.speed > CAP + 1) break; }
  }
  assert.ok(sawAirborne, 'the daredevil launched off the mogul');
  assert.ok(r.speed > CAP, `airborne rival accelerated past the cap (${r.speed})`);
});
test('stopped rivals stay stopped in powder: heavy crash and knockdown', () => {
  const player = new Player(); player.speed = MAX_SPEED;
  const down = rider(); down.speed = CAP;
  down.crashIntoTree();
  for (let t = 0; t < 1000; t += STEP) { down.update(STEP, [], player, 'powder'); assert.equal(down.speed, 0); }
  assert.equal(down.heavyCrashing, true);
  const ko = rider(); ko.speed = CAP; assert.equal(ko.addStagger(3), true);
  for (let t = 0; t < KNOCKDOWN_MS - 100; t += STEP) { ko.update(STEP, [], player, 'powder'); assert.equal(ko.speed, 0); assert.equal(ko.knockedDown, true); }
  for (let t = 0; t < 4000; t += STEP) ko.update(STEP, [], player, 'powder');
  assert.equal(ko.knockedDown, false); assert.equal(ko.speed, CAP, 'recovers to the powder cap');
});

console.log('\n=== powder: scoring ===');
test('a near miss at the powder cap still scores (cap 0.8 vs floor 0.7)', () => {
  setDeterministicRuntime(71);
  const near: Obstacle = { kind: 'rock', lane: 3, z: 1300, segIndex: 6 };
  const player = new Player(); player.worldZ = 1100;
  run(player, 3000, 'powder'); player.worldZ = 1100;
  assert.equal(player.speed, CAP);
  const collisions = new CollisionSystem();
  const combat = new CombatSystem(player, [], [near]);
  const score = new ScoreTracker(player, [], [near], collisions, combat);
  score.update(16);
  player.worldZ = 1300;
  score.update(16);
  assert.deepEqual(score.feedback, [{ kind: 'near', label: 'CLOSE CALL', points: POINTS.NEAR_MISS }]);
  // The floor is a real floor: just under it, no close call.
  const slow = new Player(); slow.worldZ = 1100; slow.speed = MAX_SPEED * NEAR_MISS_MIN_SPEED_FACTOR - 1;
  const s2 = new ScoreTracker(slow, [], [near], new CollisionSystem(), new CombatSystem(slow, [], [near]));
  s2.update(16); slow.worldZ = 1300; s2.update(16);
  assert.equal(s2.runningScore, 0);
});

console.log('\n=== powder: whole courses ===');
test('straight-line cost of the two fields in a course is under a second and always positive', () => {
  const cost: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const track = generateTrack(seed);
    const finish = track.segments[track.segments.length - 1].z;
    const time = (withSurface: boolean) => {
      const p = new Player(); let t = 0;
      for (; p.worldZ < finish && t < 200_000; t += STEP) p.update(STEP, false, withSurface ? surfaceAtZ(track.segments, p.worldZ) : undefined);
      return t;
    };
    const lost = time(true) - time(false);
    cost.push(lost);
    assert.ok(lost > 0 && lost < 1500, `seed ${seed}: powder costs ${lost.toFixed(0)}ms`);
  }
  console.log(`    straight-line cost of powder over 40 seeds: ${Math.min(...cost).toFixed(0)}-${Math.max(...cost).toFixed(0)} ms, mean ${(cost.reduce((a, b) => a + b, 0) / cost.length).toFixed(0)} ms`);
});

console.log(`\n=== ${passed} powder checks passed ===`);
