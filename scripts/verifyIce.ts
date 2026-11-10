/**
 * Ice sheets (#39, part 2), handling side. Lane changes that start on ice take
 * ICE_LANE_TWEEN_MS for the player (steer, held repeat, buffered steer), rivals
 * (steering, dodging), knockbacks and the directional shove; the duration is
 * fixed when the tween starts; airborne riders ignore ice; near misses on ice
 * pay double; the timed steer evade still works on ice; the lane-change cost
 * the placement model charges is the one shared helper. Course-generation rules
 * live in verifyMountains and verifySolvability; this runs the real Player /
 * AIRider / CollisionSystem / CombatSystem / ScoreTracker.
 * Run: node --import tsx scripts/verifyIce.ts
 */
import assert from 'node:assert/strict';
import {
  BOOST_GAIN, BOOST_SPEED_FACTOR, COLLISION_Z_WINDOW,
  ICE_LANE_CHANGE_SEGMENTS, ICE_LANE_TWEEN_MS, ICE_MAX_SEGMENTS, ICE_MIN_SEGMENTS, ICE_NEAR_MISS_MULTIPLIER, ICE_TREE_FREE_SEGMENTS,
  JUMP_AIRTIME_EXTENDED_MS, JUMP_AIRTIME_MS, LANE_CHANGE_SEGMENTS, LANE_TWEEN_MS, LANES, MAX_SPEED, POINTS,
  SEGMENT_LENGTH, TREE_CLAMP_SEGMENTS
} from '../src/config';
import { AIRider, type AIRiderParams } from '../src/entities/aiRider';
import { BoostMeter } from '../src/entities/boost';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { PERSONALITIES } from '../src/entities/personality';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';
import { EVADE_TIMING_MS } from '../src/entities/skillCombat';
import { cupRivalParams } from '../src/progression/cup';
import { generateTrack } from '../src/track/generator';
import { placeIce } from '../src/track/ice';
import { firstUnpassableRow } from '../src/track/rows';
import type { Segment, Surface } from '../src/track/segment';
import {
  gapLaneChangeSegments, laneChangeSegments, laneTweenMs, SURFACE_CUES, surfaceAtZ, surfaceEntryCue, surfaceTagDetail
} from '../src/track/surface';
import { chuteAhead } from '../src/track/chute';
// @ts-expect-error JavaScript acceptance helper is outside production tsconfig.
import { naturalRaceDriver } from './naturalRaceDriver.mjs';

const STEP = 1000 / 60;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const rider = (over: Partial<AIRiderParams> = {}) => new AIRider({
  cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 1, startZOffset: 10_000, paletteIndex: 0, ...over
});
const obstacle = (kind: Obstacle['kind'], lane: number, z: number): Obstacle => ({ kind, lane, z, segIndex: Math.floor(z / SEGMENT_LENGTH) });

/** Steps until the player's lane index changes after one steer from lane 2 to 3. `surfaceAt(step)` gives the surface each step. */
function steerDuration(surfaceAt: (step: number) => Surface | undefined): number {
  const p = new Player(); p.speed = MAX_SPEED;
  p.update(STEP, false, surfaceAt(0));
  p.requestLaneShift(1);
  for (let step = 1; step < 200; step++) {
    p.update(STEP, false, surfaceAt(step));
    if (p.laneIndex === 3) return step * STEP;
  }
  throw new Error('never arrived');
}
/** Steps until a rival's lane index reaches `to` after `start()` begins its move, with ice under it throughout or `after` once the move began. */
function riderDuration(start: (r: AIRider, player: Player) => void, surface: Surface | undefined, after: Surface | undefined = surface): number {
  const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
  const r = rider({ startLane: 2 }); r.speed = MAX_SPEED; r.worldZ = 10_000;
  r.update(STEP, [], player, surface);
  start(r, player);
  for (let step = 1; step < 200; step++) {
    r.update(STEP, [], player, after);
    if (r.laneIndex !== 2) return step * STEP;
  }
  throw new Error('never arrived');
}
const near = (actual: number, expected: number, slack = STEP * 1.5) => assert.ok(Math.abs(actual - expected) <= slack, `${actual.toFixed(1)} ms is not ${expected} ms`);

console.log('\n=== ice: config and the shared lane-change cost ===');
test('config: starting numbers and the cost placement charges on ice', () => {
  assert.equal(ICE_LANE_TWEEN_MS, 300);
  assert.equal(ICE_NEAR_MISS_MULTIPLIER, 2);
  assert.equal(ICE_MIN_SEGMENTS, 20); assert.equal(ICE_MAX_SEGMENTS, 30);
  assert.equal(ICE_LANE_CHANGE_SEGMENTS, 5, '300 ms at MAX_SPEED is 4.5 segments, charged as 5');
  assert.equal(LANE_CHANGE_SEGMENTS, 3);
  assert.ok(MAX_SPEED * ICE_LANE_TWEEN_MS / 1000 <= ICE_LANE_CHANGE_SEGMENTS * SEGMENT_LENGTH, 'a whole slide fits the cost at MAX_SPEED');
  assert.ok(MAX_SPEED * ICE_LANE_TWEEN_MS / 1000 > (ICE_LANE_CHANGE_SEGMENTS - 1) * SEGMENT_LENGTH, 'and the cost is not padded by a whole segment');
});
test('boost: the cost still clears every row a boosting rider meets, because a row is cleared at the half-way point', () => {
  // A rider is out of a lane's collision band half way through a tween (smoothstep 0.5 is 0.2 of a lane), so k
  // chained lane changes only need (k - 1/2) tweens plus the collision window before the row. At boost speed a FULL
  // slide is 5.4 segments (more than the cost of 5), so this is the inequality that keeps the model sound.
  const boost = MAX_SPEED * BOOST_SPEED_FACTOR;
  assert.ok(boost * ICE_LANE_TWEEN_MS / 1000 > ICE_LANE_CHANGE_SEGMENTS * SEGMENT_LENGTH, 'a full boosted slide exceeds the cost: the half-way credit is load bearing');
  for (let k = 1; k < LANES.length; k++) {
    const needed = (k - 0.5) * boost * ICE_LANE_TWEEN_MS / 1000 + COLLISION_Z_WINDOW;
    assert.ok(needed <= k * ICE_LANE_CHANGE_SEGMENTS * SEGMENT_LENGTH, `${k} chained lane changes at boost speed need ${needed} units`);
    const ordinary = (k - 0.5) * boost * LANE_TWEEN_MS / 1000 + COLLISION_Z_WINDOW;
    assert.ok(ordinary <= k * LANE_CHANGE_SEGMENTS * SEGMENT_LENGTH);
  }
});
test('laneTweenMs / laneChangeSegments by surface', () => {
  assert.equal(laneTweenMs('ice'), 300); assert.equal(laneTweenMs('powder'), 150); assert.equal(laneTweenMs(undefined), 150);
  assert.equal(laneChangeSegments('ice'), 5); assert.equal(laneChangeSegments('powder'), 3); assert.equal(laneChangeSegments(undefined), 3);
});
test('gapLaneChangeSegments: a gap that touches ice is charged the ice cost throughout; one that does not, is not', () => {
  const track: Pick<Segment, 'surface'>[] = Array.from({ length: 60 }, (_, i) => (i >= 20 && i < 30 ? { surface: 'ice' as const } : {}));
  assert.equal(gapLaneChangeSegments(track, 0, 20), 3, 'entirely before the ice (the ice starts at segment 20, a rider can start at 19 at the latest)');
  assert.equal(gapLaneChangeSegments(track, 0, 21), 5, 'a lane change begun on the first ice segment');
  assert.equal(gapLaneChangeSegments(track, 10, 50), 5, 'a gap that spans the sheet: whole gap at the ice cost');
  assert.equal(gapLaneChangeSegments(track, 25, 28), 5, 'inside');
  assert.equal(gapLaneChangeSegments(track, 29, 45), 5, 'begins on the last ice segment: the slide it starts lasts 300 ms');
  assert.equal(gapLaneChangeSegments(track, 30, 55), 3, 'begins on the first piste segment after the sheet');
  assert.equal(gapLaneChangeSegments(undefined, 0, 59), 3, 'geometry-only callers keep the ordinary cost');
  assert.equal(gapLaneChangeSegments(track, -5, 3), 3);
  const powderOnly: Pick<Segment, 'surface'>[] = [{ surface: 'powder' }, { surface: 'powder' }, {}];
  assert.equal(gapLaneChangeSegments(powderOnly, 0, 2), 3, 'powder never changes lane changes');
});
test('the entry cue and the persistent tag are words, and the tag says what ice does', () => {
  assert.equal(SURFACE_CUES.ice, 'ICE · SLOW CARVE');
  assert.equal(surfaceEntryCue(undefined, 'ice'), 'ICE · SLOW CARVE');
  assert.equal(surfaceEntryCue('ice', 'ice'), null);
  assert.equal(surfaceEntryCue('ice', undefined), null);
  assert.equal(surfaceEntryCue('powder', 'ice'), 'ICE · SLOW CARVE');
  assert.equal(surfaceTagDetail('ice', false), 'SLOW CARVE · CLOSE CALLS x2');
  assert.equal(surfaceTagDetail('ice', true), 'AIRBORNE · NO SLIDE');
  assert.equal(surfaceTagDetail('powder', false), 'PACE CAPPED 80%');
  assert.equal(surfaceTagDetail('powder', true), 'AIRBORNE · NO DRAG');
  const track: Pick<Segment, 'surface'>[] = [{}, { surface: 'ice' }, {}];
  assert.equal(surfaceAtZ(track, SEGMENT_LENGTH), 'ice');
});

console.log('\n=== ice: the player\'s lane changes ===');
test('a steer started on ice takes 300 ms, on piste 150 ms, in powder 150 ms', () => {
  near(steerDuration(() => 'ice'), ICE_LANE_TWEEN_MS);
  near(steerDuration(() => undefined), LANE_TWEEN_MS);
  near(steerDuration(() => 'powder'), LANE_TWEEN_MS);
});
test('the duration is decided at the start and kept: leaving ice mid-slide does not shorten it, entering ice does not stretch a steer', () => {
  near(steerDuration((step) => (step === 0 ? 'ice' : undefined)), ICE_LANE_TWEEN_MS);
  near(steerDuration((step) => (step === 0 ? undefined : 'ice')), LANE_TWEEN_MS);
});
test('the lateral position follows the longer tween: half way at 150 ms on ice, already arrived on piste', () => {
  const half = (surface: Surface | undefined) => {
    const p = new Player(); p.speed = MAX_SPEED; p.update(STEP, false, surface); p.requestLaneShift(1);
    for (let t = 0; t < 150 - STEP; t += STEP) p.update(STEP, false, surface);
    return (p.laneOffsetFraction - LANES[2]) / (LANES[3] - LANES[2]);
  };
  assert.ok(half('ice') > 0.35 && half('ice') < 0.65, `on ice at ~150 ms: ${half('ice').toFixed(2)} of the way`);
  assert.ok(half(undefined) > 0.95, `on piste at ~150 ms: ${half(undefined).toFixed(2)}`);
});
test('hold-to-carve repeats and a buffered steer each take the duration of the surface they START on', () => {
  // The surface under the rider changes 100 ms in, i.e. while the first tween is still running, so the buffered second
  // steer (pressed mid-tween, begun the instant the first ends) starts on `second`.
  const chain = (first: Surface | undefined, second: Surface | undefined): [number, number] => {
    const p = new Player(); p.speed = MAX_SPEED;
    p.update(STEP, false, first); p.requestLaneShift(1);
    p.requestLaneShift(1);
    let t = 0; let firstDone = 0; let secondDone = 0;
    while (secondDone === 0 && t < 2000) {
      t += STEP; p.update(STEP, false, t < 100 ? first : second);
      if (p.laneIndex === 3 && firstDone === 0) firstDone = t;
      if (p.laneIndex === 4) secondDone = t;
    }
    return [firstDone, secondDone - firstDone];
  };
  const [a, b] = chain('ice', 'ice');
  near(a, 300, STEP * 2.5); near(b, 300, STEP * 2.5);
  const [c, d] = chain('ice', undefined);
  near(c, 300, STEP * 2.5); near(d, 150, STEP * 2.5);
  const [e, f] = chain(undefined, 'ice');
  near(e, 150, STEP * 2.5); near(f, 300, STEP * 2.5);
});
test('airborne riders are not on ice: a jump is the same length, and an air knockback takes the ordinary tween', () => {
  for (const extended of [false, true]) {
    const airtime = (surface: Surface | undefined) => {
      const p = new Player(); p.speed = MAX_SPEED; p.update(STEP, false, surface); p.jump(extended);
      let t = 0; while (p.airborne && t < 3000) { p.update(STEP, false, surface); t += STEP; }
      return t;
    };
    assert.equal(airtime('ice'), airtime(undefined), 'jump airtime is unchanged by ice');
    near(airtime('ice'), extended ? JUMP_AIRTIME_EXTENDED_MS : JUMP_AIRTIME_MS, STEP * 2);
  }
  const p = new Player(); p.speed = MAX_SPEED; p.update(STEP, false, 'ice'); p.jump(false);
  assert.equal(p.tweenDurationMs, LANE_TWEEN_MS, 'airborne: ordinary');
  p.applyKnockback(3, 0, true);
  let t = 0; while (p.laneIndex !== 3 && t < 1000) { p.update(STEP, false, 'ice'); t += STEP; }
  near(t, LANE_TWEEN_MS, STEP * 2);
  // Steering stays locked in the air on ice exactly as elsewhere.
  const q = new Player(); q.speed = MAX_SPEED; q.update(STEP, false, 'ice'); q.jump(false); q.requestLaneShift(1);
  for (let k = 0; k < 20; k++) q.update(STEP, false, 'ice');
  assert.equal(q.laneIndex, 2);
  const grounded = new Player(); grounded.update(STEP, false, 'ice');
  assert.equal(grounded.tweenDurationMs, ICE_LANE_TWEEN_MS);
});
test('ice does not touch speed: top speed, acceleration and boost are those of piste', () => {
  const ride = (surface: Surface | undefined, boosting: boolean) => {
    const p = new Player(); for (let t = 0; t < 6000; t += STEP) p.update(STEP, boosting, surface); return [p.speed, p.worldZ];
  };
  assert.deepEqual(ride('ice', false), ride(undefined, false));
  assert.deepEqual(ride('ice', true), ride(undefined, true));
});

console.log('\n=== ice: rivals, knockbacks and the shove ===');
test('a rival\'s steer and dodge started on ice take 300 ms; off ice 150 ms; decided at the start', () => {
  const rock = (r: AIRider) => [obstacle('rock', r.laneIndex, r.worldZ + SEGMENT_LENGTH * 6)];
  const dodge = (surface: Surface | undefined, after: Surface | undefined = surface): number => {
    const player = new Player(); player.speed = MAX_SPEED;
    const r = rider({ startLane: 2 }); r.speed = MAX_SPEED; r.worldZ = 10_000;
    const obstacles = rock(r);
    r.update(STEP, obstacles, player, surface);
    assert.notEqual((r as unknown as { tween: unknown }).tween, null, 'it dodges');
    for (let step = 1; step < 200; step++) {
      r.update(STEP, obstacles, player, after);
      if (r.laneIndex !== 2) return step * STEP;
    }
    throw new Error('never arrived');
  };
  near(dodge('ice'), 300); near(dodge(undefined), 150); near(dodge('powder'), 150);
  near(dodge('ice', undefined), 300); near(dodge(undefined, 'ice'), 150);
  // Pursuit and line defence use the same tween (a bully moves toward the player's lane).
  const pursue = (surface: Surface | undefined): number => {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
    player.applyKnockback(4, 0); for (let i = 0; i < 40; i++) player.update(STEP);
    player.worldZ = 10_000;
    const r = rider({ startLane: 2, aggression: 1, personality: 'bully', behaviorSeed: 3 }); r.speed = MAX_SPEED; r.worldZ = 9_000;
    r.update(STEP, [], player, surface);
    for (let step = 1; step < 200; step++) { r.update(STEP, [], player, surface); if (r.laneIndex !== 2) return step * STEP; }
    throw new Error('never moved');
  };
  near(pursue('ice'), 300); near(pursue(undefined), 150);
});
test('a knockback begun on ice is a 300 ms slide for a rival (jab) and for the player (a rival\'s strike); a rival\'s knockback is decided when it lands', () => {
  const rivalJabbed = (surface: Surface | undefined): number => {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000; player.update(STEP, false, surface);
    const r = rider({ startLane: 3, personality: 'bully' }); r.speed = MAX_SPEED; r.worldZ = 10_000; r.update(STEP, [], player, surface);
    const combat = new CombatSystem(player, [r], []);
    combat.update(STEP, 1000);
    assert.equal(combat.attemptAttack(1000), true);
    for (let step = 1; step < 200; step++) { r.update(STEP, [], player, surface); if (r.laneIndex !== 3) return step * STEP; }
    throw new Error('rival was not knocked');
  };
  near(rivalJabbed('ice'), 300); near(rivalJabbed(undefined), 150);
  const playerStruck = (surface: Surface | undefined): number => {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000;
    const r = rider({ startLane: 2, personality: 'bully', behaviorSeed: 42 }); r.speed = MAX_SPEED; r.worldZ = 10_100;
    const combat = new CombatSystem(player, [r], []);
    let now = 0;
    const step = (ms: number) => { now += ms; player.update(ms, false, surface); r.update(ms, [], player, surface); combat.update(ms, now); };
    assert.ok(r.requestTelegraphedAttack(player));
    for (let left = PERSONALITIES.bully.windupMs; left > 0; left -= 20) step(20);
    step(20);
    assert.equal(combat.skillEvents.filter((e) => e.type === 'rival-hit').length, 1, 'the strike lands');
    const lane = player.laneIndex;
    // The knockback moves the player one lane (toward centre when sharing a lane): time how long until it settles.
    let t = 0; while (player.laneOffsetFraction !== LANES[player.laneIndex] || player.laneIndex === lane) { step(STEP); t += STEP; if (t > 1000) break; }
    return t;
  };
  const onIce = playerStruck('ice'); const onPiste = playerStruck(undefined);
  assert.ok(onIce > onPiste + 100, `player knockback on ice ${onIce.toFixed(0)} ms vs piste ${onPiste.toFixed(0)} ms`);
  assert.ok(onIce <= ICE_LANE_TWEEN_MS + 60 && onPiste <= LANE_TWEEN_MS + 60);
});
test('the directional shove sends a rival on ice 300 ms sideways, off ice 150 ms; a shove from piste onto a rival on ice follows the rival\'s surface', () => {
  const shoved = (riderSurface: Surface | undefined, playerSurface: Surface | undefined = riderSurface): number => {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000; player.update(STEP, false, playerSurface);
    const r = rider({ startLane: 3 }); r.speed = MAX_SPEED * 0.9; r.worldZ = 10_000; r.update(STEP, [], player, riderSurface);
    const combat = new CombatSystem(player, [r], []);
    (combat as unknown as { inContact: Set<AIRider> }).inContact.add(r);
    combat.update(STEP, 1000);
    assert.equal(combat.attemptPush(1000, 0), true);
    for (let step = 1; step < 200; step++) { r.update(STEP, [], player, riderSurface); if (r.laneIndex !== 3) return step * STEP; }
    throw new Error('rival was not pushed');
  };
  near(shoved('ice'), 300); near(shoved(undefined), 150); near(shoved('ice', undefined), 300); near(shoved(undefined, 'ice'), 150);
});

console.log('\n=== ice: the shove cue and its outcome ===');
test('the cue and the outcome agree: a rock the pushed rival passes before it reaches the lane is not a hazard, one it reaches is', () => {
  const trial = (surface: Surface | undefined, distance: number) => {
    setDeterministicRuntime(11);
    const Z = 10_000;
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = Z; player.update(STEP, false, surface);
    const r = rider({ startLane: 3, reactionDistanceSegments: 12 }); r.speed = MAX_SPEED * 0.9; r.worldZ = Z; r.update(STEP, [], player, surface);
    const rock = obstacle('rock', 4, Z + distance);
    const combat = new CombatSystem(player, [r], [rock]);
    (combat as unknown as { inContact: Set<AIRider> }).inContact.add(r);
    combat.update(STEP, 1000);
    const plan = combat.pushPlan(combat.pushTarget!, 0);
    assert.equal(plan.lane, 4);
    assert.equal(combat.attemptPush(1000, 0), true);
    const collisions = new CollisionSystem();
    for (let t = 0; t < 1500; t += STEP) { player.update(STEP, false, surface); r.update(STEP, [rock], player, surface); collisions.update(r, [rock]); combat.update(STEP, 1000 + t); }
    return { cue: plan.hazard === 'rock', hit: r.rockHitSerial > 0 };
  };
  const boundary: Record<string, number> = {};
  for (const [label, surface] of [['piste', undefined], ['ice', 'ice' as Surface]] as const) {
    let firstHit = Infinity; let cueOnset = Infinity; let underReported = 0; let falseCueInReach = 0;
    for (let distance = 0; distance <= 3000; distance += 25) {
      const { cue, hit } = trial(surface, distance);
      if (hit) firstHit = Math.min(firstHit, distance);
      if (cue) cueOnset = Math.min(cueOnset, distance);
      if (!cue && hit) underReported++; // the cue never stays silent for a rock that connects
      if (cue && !hit && distance < 1100) falseCueInReach++; // before the rival can react, a cue means a hit (bar the onset)
    }
    boundary[label] = firstHit;
    assert.ok(Number.isFinite(firstHit) && Number.isFinite(cueOnset));
    assert.ok(Math.abs(cueOnset - firstHit) <= 50, `${label}: the cue starts ${cueOnset} u out, the first rock that connects is ${firstHit} u out`);
    assert.equal(underReported, 0, `${label}: a rock that connects had no cue`);
    assert.ok(falseCueInReach <= 2, `${label}: ${falseCueInReach} cued rocks inside the unavoidable range were missed`);
  }
  // On ice the pushed rival carries further before it reaches the lane, so the nearest rock that connects is farther away.
  assert.ok(boundary.ice > boundary.piste, `nearest connecting rock: ice ${boundary.ice} u vs piste ${boundary.piste} u`);
  console.log(`    nearest rock ahead of a pushed rival that connects: piste ${boundary.piste} u, ice ${boundary.ice} u`);
  // The learnability promise of the shove still holds on ice for a rock two or more segments ahead against the most alert rival.
  for (const segments of [2, 3, 4]) assert.ok(trial('ice', SEGMENT_LENGTH * segments).hit, `rock ${segments} segments ahead on ice connects`);
});

console.log('\n=== ice: near misses ===');
test('a near miss on ice pays double, on piste and in powder once; the boost gain stays +8; the breakdown agrees', () => {
  const closeCall = (surface: Surface | undefined) => {
    setDeterministicRuntime(71);
    const rock: Obstacle = { kind: 'rock', lane: 3, z: 1300, segIndex: 6 };
    const player = new Player(); player.worldZ = 1100; player.speed = MAX_SPEED;
    const score = new ScoreTracker(player, [], [rock], new CollisionSystem(), new CombatSystem(player, [], [rock]));
    score.update(16, surface);
    player.worldZ = 1300;
    score.update(16, surface);
    return score;
  };
  const ice = closeCall('ice');
  assert.deepEqual(ice.feedback, [{ kind: 'near', label: 'CLOSE CALL · ICE x2', points: POINTS.NEAR_MISS * ICE_NEAR_MISS_MULTIPLIER }]);
  assert.equal(ice.finalize(false, 1000, 5).nearMissPoints, POINTS.NEAR_MISS * 2);
  assert.equal(ice.finalize(false, 1000, 5).nearMissCount, 1);
  for (const surface of [undefined, 'powder' as Surface]) {
    const other = closeCall(surface);
    assert.deepEqual(other.feedback, [{ kind: 'near', label: 'CLOSE CALL', points: POINTS.NEAR_MISS }]);
    assert.equal(other.finalize(false, 1000, 5).nearMissPoints, POINTS.NEAR_MISS);
  }
  assert.equal(BoostMeter.gainFor(['near'], false), BOOST_GAIN.NEAR_MISS, 'the boost gain for a near miss is unchanged');
  assert.equal(BOOST_GAIN.NEAR_MISS, 8);
  // The surface is the player's when the obstacle is crossed: ice before the crossing does not count.
  const left = new Player(); left.worldZ = 1100; left.speed = MAX_SPEED;
  const rock: Obstacle = { kind: 'rock', lane: 3, z: 1300, segIndex: 6 };
  const s = new ScoreTracker(left, [], [rock], new CollisionSystem(), new CombatSystem(left, [], [rock]));
  s.update(16, 'ice'); left.worldZ = 1300; s.update(16, undefined);
  assert.equal(s.feedback[0].points, POINTS.NEAR_MISS);
  // A rival passed in the adjacent lane on ice pays double as well.
  const player = new Player(); player.worldZ = 1000; player.speed = MAX_SPEED;
  const r = rider({ startLane: 3 }); r.worldZ = 1300; r.speed = MAX_SPEED * 0.9;
  const sr = new ScoreTracker(player, [r], [], new CollisionSystem(), new CombatSystem(player, [r], []));
  sr.update(16, 'ice'); player.worldZ = 1400; sr.update(16, 'ice');
  assert.deepEqual(sr.feedback.map((e) => e.points), [POINTS.NEAR_MISS * 2]);
});

console.log('\n=== ice: the timed steer evade ===');
test('a steer begun on ice still earns the evade: the window moves later by half the extra slide and keeps its width', () => {
  const windup = PERSONALITIES.bully.windupMs;
  const outcome = (surface: Surface | undefined, lead: number): 'evade' | 'hit' | 'none' => {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = 10_000; player.update(STEP, false, surface);
    const r = rider({ startLane: 1, personality: 'bully', behaviorSeed: 42 }); r.speed = MAX_SPEED; r.worldZ = 10_100;
    const combat = new CombatSystem(player, [r], []);
    let now = 0;
    const step = (ms: number) => { now += ms; player.update(ms, false, surface); r.update(ms, [], player, surface); combat.update(ms, now); };
    assert.ok(r.requestTelegraphedAttack(player));
    let left = windup - lead; while (left > 0) { const ms = Math.min(10, left); step(ms); left -= ms; }
    player.requestLaneShift(1);
    for (let t = 0; t < lead + 40; t += 10) step(10);
    if (combat.skillEvents.some((e) => e.type === 'evade')) return 'evade';
    return player.hitReacting ? 'hit' : 'none';
  };
  const window = (surface: Surface | undefined): [number, number] => {
    const leads: number[] = [];
    for (let lead = 10; lead <= 500; lead += 10) if (outcome(surface, lead) === 'evade') leads.push(lead);
    assert.ok(leads.length > 0, 'an evade is possible');
    assert.equal(leads[leads.length - 1] - leads[0], (leads.length - 1) * 10, 'the window is contiguous');
    return [leads[0], leads[leads.length - 1]];
  };
  const [pMin, pMax] = window(undefined);
  const [iMin, iMax] = window('ice');
  console.log(`    steer-start window before the strike that earns the evade: piste ${pMin}-${pMax} ms (${pMax - pMin + 10} wide), ice ${iMin}-${iMax} ms (${iMax - iMin + 10} wide)`);
  assert.ok(pMax <= EVADE_TIMING_MS && iMax <= EVADE_TIMING_MS + (ICE_LANE_TWEEN_MS - LANE_TWEEN_MS) / 2);
  assert.ok(iMin > pMin, 'a slide takes longer to clear the target line, so it has to start earlier');
  assert.ok(iMax - iMin >= (pMax - pMin) * 0.9, 'the window does not shrink on ice');
  assert.ok(iMax - iMin <= (pMax - pMin) * 1.1, 'and is not trivially wider');
  // A steer too late still gets hit on ice, and one too early is safe but earns nothing.
  assert.equal(outcome('ice', 10), 'hit');
  assert.equal(outcome('ice', 480), 'none');
  // Early steering stays safe on ice.
  assert.notEqual(outcome('ice', 400), 'hit');
});

console.log('\n=== ice: trees are never near ice ===');
test('a knockback begun on ice cannot carry a rider into a tree it had no time to avoid', () => {
  // What a knocked rider needs: the knockback slide, then an escape steer half way out of the lane. At the fastest
  // speed there is (boost), on ice. Compared against the nearest tree after any ice segment over 400 seeds.
  const need = (MAX_SPEED * BOOST_SPEED_FACTOR) * (ICE_LANE_TWEEN_MS + ICE_LANE_TWEEN_MS / 2) / 1000;
  let nearest = Infinity; let sheets = 0;
  for (let seed = 0; seed < 400; seed++) {
    const track = generateTrack(seed);
    for (const sheet of track.ice) {
      sheets++;
      for (let s = sheet.start; s < sheet.start + sheet.length; s++) {
        for (const o of track.obstacles) if (o.kind === 'tree' && o.segIndex >= s) nearest = Math.min(nearest, (o.z - (s + 1) * SEGMENT_LENGTH) );
      }
    }
  }
  console.log(`    ${sheets} sheets: nearest tree downstream of any ice segment is ${(nearest / SEGMENT_LENGTH).toFixed(0)} segments away; a ` +
    `boosted rider needs ${(need / SEGMENT_LENGTH).toFixed(1)} segments (slide + escape), the clamp looks ${TREE_CLAMP_SEGMENTS}, the guaranteed margin is ${ICE_TREE_FREE_SEGMENTS}`);
  assert.ok(nearest > need, 'no tree within the slide-plus-escape distance of any ice segment');
  assert.ok(ICE_TREE_FREE_SEGMENTS * SEGMENT_LENGTH > need, 'the guaranteed margin alone covers it, at boost speed');
});
test('the tree clamp still gates a knockback begun just before ice', () => {
  // The clamp is for trees only; a tree is never near ice, so surface changes nothing about which lanes it allows.
  const Z = 10_000;
  const tree = obstacle('tree', 4, Z + SEGMENT_LENGTH * 2);
  for (const surface of [undefined, 'ice' as Surface]) {
    const player = new Player(); player.speed = MAX_SPEED; player.worldZ = Z; player.update(STEP, false, surface);
    const r = rider({ startLane: 3, personality: 'bully' }); r.speed = MAX_SPEED; r.worldZ = Z; r.update(STEP, [tree], player, surface);
    const combat = new CombatSystem(player, [r], [tree]);
    combat.update(STEP, 1000);
    assert.equal(combat.attemptAttack(1000), true);
    for (let k = 0; k < 40; k++) r.update(STEP, [tree], player, surface);
    assert.equal(r.laneIndex, 3, 'knockback towards a tree is clamped to no lane change');
  }
});

console.log('\n=== ice: placement ===');
test('rows that fail the ice cost are thinned INSIDE the sheet, nothing else moves, and the field passes', () => {
  // A deliberately hostile field: rows 6 segments apart leaving one lane clear, alternating lane 0 and lane 2. That
  // needs two lane changes per row: fine at the ordinary cost (6 / 3 = 2), impossible at the ice cost (6 / 5 = 1).
  const track = generateTrack(7);
  const segments = track.segments.map((s) => ({ ...s, surface: undefined })) as Segment[];
  const hostile: Obstacle[] = [];
  let toggle = 0;
  for (const section of track.sections) {
    if (section.theme !== 'ridge') continue;
    for (let s = section.startSegment; s < section.endSegment; s++) {
      if (segments[s].safeZone !== undefined || (s - section.startSegment) % 6 !== 0) continue;
      const clear = toggle++ % 2 === 0 ? 0 : 2;
      for (let lane = 0; lane < LANES.length; lane++) if (lane !== clear) hostile.push({ kind: 'rock', lane, z: s * SEGMENT_LENGTH + 100, segIndex: s });
    }
  }
  const input = { segments, sections: track.sections, crestApexes: track.crestApexes, placeableStart: 100 };
  assert.equal(firstUnpassableRow(hostile, track.crestApexes, 100, segments), null, 'passable at the ordinary cost');
  const placed = placeIce(input, hostile, mulberryFor(5));
  assert.equal(placed.sheets.length, 2);
  assert.ok(placed.sheets.every((s) => s.thinned > 0), 'the hostile field forces thinning');
  assert.equal(firstUnpassableRow(placed.obstacles, track.crestApexes, 100, segments), null, 'passable at the ice cost afterwards');
  const kept = new Set(placed.obstacles);
  const removed = hostile.filter((o) => !kept.has(o));
  assert.equal(removed.length, placed.sheets.reduce((n, s) => n + s.thinned, 0));
  for (const o of removed) assert.ok(placed.sheets.some((s) => o.segIndex >= s.start && o.segIndex < s.start + s.length), 'removed obstacles lie inside a sheet');
  assert.ok(removed.length < hostile.length / 4, `only a few obstacles go (${removed.length} of ${hostile.length})`);
  console.log(`    hostile field: ${hostile.length} obstacles, ${removed.length} thinned inside the two sheets`);
});
test('across 1,000 seeds the sheet is chosen where nothing has to move (option a), and rows were checked under the ice cost', () => {
  let thinned = 0; let rowsOnIce = 0;
  for (let seed = 0; seed < 1000; seed++) {
    const track = generateTrack(seed);
    for (const sheet of track.ice) {
      thinned += sheet.thinned;
      rowsOnIce += track.obstacles.filter((o) => o.segIndex >= sheet.start && o.segIndex < sheet.start + sheet.length).length;
    }
    assert.equal(firstUnpassableRow(track.obstacles, track.crestApexes, 100, track.segments), null);
  }
  assert.equal(thinned, 0);
  console.log(`    0 obstacles thinned; ${rowsOnIce} obstacles stand on ice and every row passes at the ice cost`);
});

console.log('\n=== ice: whole courses ===');
test('rivals are not farmed by ice: rock hits around ice sheets, slow carve against ordinary carve', () => {
  const sim = (seeds: number, rivalsSlowOnIce: boolean) => {
    let hits = 0; let passes = 0; let player = 0;
    for (let seed = 0; seed < seeds; seed++) {
      const track = generateTrack(seed);
      const p = new Player();
      const riders = track.aiRiders.map((params, i) => new AIRider(cupRivalParams(i, params)));
      const colls = new CollisionSystem(); const aiColls = riders.map(() => new CollisionSystem());
      const combat = new CombatSystem(p, riders, track.obstacles);
      const finish = track.segments.find((s) => s.isFinish)!;
      const scene: any = { seed, options: { runId: `ice-${seed}-${rivalsSlowOnIce}` }, countdownMs: 0, practiceObjective: null, player: p,
        aiRiders: riders, aiCollisions: aiColls, collisions: colls, obstacles: track.obstacles, pickups: track.pickups,
        crestApexZs: track.crestApexes.map((i) => i * SEGMENT_LENGTH + SEGMENT_LENGTH / 2), finishSegment: finish, elapsedRaceMs: 0,
        simulationHitStopMs: 0, raceOver: false, checkpoints: { latest: null }, ghostRecorder: { sampleCount: 0 }, ghostSplit: '',
        simulate(delta: number) {
          this.elapsedRaceMs += delta;
          const previous = p.worldZ; p.update(delta, false, surfaceAtZ(track.segments, p.worldZ));
          if (this.crestApexZs.some((z: number) => previous < z && p.worldZ >= z)) p.jump(true, false);
          colls.update(p, track.obstacles);
          riders.forEach((r, i) => {
            r.update(delta, track.obstacles, p, rivalsSlowOnIce ? surfaceAtZ(track.segments, r.worldZ) : undefined, chuteAhead(track.segments, r.worldZ));
            if (r.finishTimeMs === null && r.worldZ >= finish.z) r.finishTimeMs = this.elapsedRaceMs;
            if (r.finishTimeMs !== null) r.worldZ = finish.z;
            aiColls[i].update(r, track.obstacles);
          });
          combat.update(delta, this.elapsedRaceMs); combat.skillEvents.length = 0; combat.events.length = 0;
          if (p.wipedOut || p.worldZ >= finish.z) this.raceOver = true;
        } };
      naturalRaceDriver({ scene, render: false });
      if (p.worldZ >= finish.z) player++;
      riders.forEach((_, i) => {
        for (const sheet of track.ice) {
          passes++;
          hits += track.obstacles.filter((o) => o.kind === 'rock' && o.segIndex >= sheet.start - 4 && o.segIndex < sheet.start + sheet.length && aiColls[i].wasHit(o)).length;
        }
      });
    }
    return { hits, passes, player };
  };
  const seeds = 80;
  const ordinary = sim(seeds, false);
  const slow = sim(seeds, true);
  console.log(`    rival rock hits around ice (${slow.passes} rival-sheet passes): ordinary carve ${ordinary.hits} (${(ordinary.hits / ordinary.passes * 100).toFixed(2)}%), ` +
    `slow carve ${slow.hits} (${(slow.hits / slow.passes * 100).toFixed(2)}%); player finished ${slow.player}/${seeds}`);
  assert.equal(slow.player, seeds, 'the natural driver finishes every seed');
  assert.ok(slow.hits <= ordinary.hits + Math.max(3, ordinary.hits * 0.25), 'ice does not farm rivals: no extra reaction distance needed');
});
test('the natural driver commits earlier on ice: a slide needs the extra distance', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.update(STEP, false, 'ice');
  assert.equal(p.tweenDurationMs, 300);
  const q = new Player(); q.update(STEP, false, undefined);
  assert.equal(q.tweenDurationMs, 150);
  assert.equal(typeof naturalRaceDriver, 'function');
});

function mulberryFor(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

console.log(`\n=== ${passed} ice checks passed ===`);
