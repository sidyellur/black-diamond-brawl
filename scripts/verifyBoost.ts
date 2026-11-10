/** Boost meter model checks: meter rules, speed model, safety margins and a
 * deterministic boosted full-course run through the real entities. Mirrors
 * RaceScene.simulate ordering; no Phaser. */
import assert from 'node:assert/strict';
import {
  BLIND_LANDING_SEGMENTS, BOOST_ACCEL_FACTOR, BOOST_DECAY_MS, BOOST_FULL_DURATION_MS, BOOST_GAIN, BOOST_MAX,
  BOOST_MIN_TO_START, BOOST_SPEED_FACTOR, JUMP_AIRTIME_EXTENDED_MS, JUMP_AIRTIME_MS, JUMP_REACH_EXTENDED,
  JUMP_REACH_NORMAL, LANE_CHANGE_SEGMENTS, LANE_TWEEN_MS, MAX_SPEED, PAR_TIME, PLAYER_ACCEL, SEGMENT_LENGTH
} from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { BoostMeter } from '../src/entities/boost';
import { CollisionSystem, isMogulLaunchAvailable } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';
import { generateTrack } from '../src/track/generator';
import { surfaceAtZ } from '../src/track/surface';
import { chuteAhead } from '../src/track/chute';

const STEP = 1000 / 60;
/** One fixed step of travel at MAX_SPEED, in segments: airtime is quantised to whole steps. */
const STEP_SLACK = MAX_SPEED * STEP / 1000 / SEGMENT_LENGTH;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const calm = { wipedOut: false, heavyCrashing: false, tumbling: false, stumbling: false, hitReacting: false, airborne: false };

function full(): BoostMeter { const m = new BoostMeter(); m.add(BOOST_MAX); return m; }

console.log('\n=== boost meter ===');
test('meter starts empty and gains match the table, capped at BOOST_MAX', () => {
  const m = new BoostMeter();
  assert.equal(m.value, 0);
  assert.deepEqual(BOOST_GAIN, { NEAR_MISS: 8, TRICK_LANDING: 15, HIT: 12, COUNTER: 25, KNOCKOUT: 30 });
  for (const [kinds, counter, expected] of [
    [['near'], false, 8], [['trick'], false, 15], [['hit'], false, 12], [['knockout'], false, 30],
    [['brush'], false, 0], [['hit'], true, 25], [['hit', 'knockout'], false, 42], [['hit', 'knockout'], true, 55],
    [['near', 'trick'], false, 23], [[], false, 0]
  ] as const) {
    const fresh = new BoostMeter();
    fresh.addFeedback(kinds, counter);
    assert.equal(fresh.value, expected, `${kinds.join('+')} counter=${counter}`);
  }
  m.add(90); m.add(90);
  assert.equal(m.value, BOOST_MAX);
  m.add(-50);
  assert.equal(m.value, BOOST_MAX, 'negative adds are ignored');
});

test('boost needs BOOST_MIN_TO_START and an empty meter never starts', () => {
  const m = new BoostMeter();
  m.add(BOOST_MIN_TO_START - 1);
  m.update(STEP, true);
  assert.equal(m.active, false);
  assert.equal(m.value, BOOST_MIN_TO_START - 1);
  m.add(1);
  m.update(STEP, true);
  assert.equal(m.active, true);
  const empty = new BoostMeter();
  empty.update(STEP, true);
  assert.equal(empty.active, false);
});

test('a full meter burns for BOOST_FULL_DURATION_MS and stops when empty', () => {
  const m = full();
  let steps = 0;
  while (true) {
    m.update(STEP, true);
    if (!m.active) break;
    steps++;
    assert.ok(steps < 1000);
  }
  near(steps * STEP, BOOST_FULL_DURATION_MS, STEP, 'burn time');
  assert.equal(m.value, 0);
  m.add(BOOST_MAX);
  m.update(STEP, true); // still held: a full meter may start again immediately
  assert.equal(m.active, true);
});

test('once started, boost keeps burning below the minimum until released or empty', () => {
  const m = full();
  for (let i = 0; i < 130; i++) m.update(STEP, true);
  assert.ok(m.value < BOOST_MIN_TO_START && m.value > 0 && m.active);
  m.update(STEP, false);
  assert.equal(m.active, false);
  const after = m.value;
  m.update(STEP, false);
  assert.equal(m.value, after, 'no burn while released');
  m.update(STEP, true);
  assert.equal(m.active, false, 'below the minimum cannot restart');
});

test('rock and lost exchanges halve the meter and end boost; mogul only ends boost', () => {
  for (const [label, hurt, kept] of [
    ['rock', { tumbling: true }, 0.5], ['lost exchange', { hitReacting: true }, 0.5], ['mogul', { stumbling: true }, 1]
  ] as const) {
    const m = full();
    m.update(STEP, true);
    assert.equal(m.active, true);
    const before = m.value;
    m.observe({ ...calm, ...hurt });
    assert.equal(m.active, false, label);
    near(m.value, before * kept, 1e-9, label);
    m.update(STEP, true);
    assert.equal(m.active, false, `${label}: held button must not restart the boost`);
    m.observe(calm);
    m.update(STEP, false);
    m.update(STEP, true);
    assert.equal(m.active, true, `${label}: release then press restarts`);
  }
  // One event is penalised once, not every frame it stays true.
  const m = full();
  m.observe({ ...calm, tumbling: true }); m.observe({ ...calm, tumbling: true }); m.observe({ ...calm, tumbling: true });
  assert.equal(m.value, BOOST_MAX * 0.5);
});

test('a heavy tree crash empties the meter and ends boost (a rock only halves it)', () => {
  const m = full();
  m.update(STEP, true);
  assert.equal(m.active, true);
  m.observe({ ...calm, heavyCrashing: true, tumbling: true });
  assert.equal(m.value, 0, 'meter emptied, not halved');
  assert.equal(m.active, false);
  m.add(BOOST_MAX);
  m.update(STEP, true);
  assert.equal(m.active, false, 'held button must not restart the boost');
  // Emptied once per crash, not every frame it stays true.
  m.observe({ ...calm, heavyCrashing: true, tumbling: true });
  assert.equal(m.value, BOOST_MAX);
  m.observe(calm); m.update(STEP, false); m.update(STEP, true);
  assert.equal(m.active, true, 'release then press restarts');
  // The real Player drives the same signal end to end.
  const p = new Player(), meter = full();
  meter.observe(p); p.speed = MAX_SPEED; p.crashIntoTree(); meter.observe(p);
  assert.equal(meter.value, 0);
  for (let i = 0; i < 100; i++) { meter.update(STEP, true, !p.tumbling); p.update(STEP, meter.active); meter.observe(p); }
  assert.ok(p.speed <= MAX_SPEED, 'no boost speed while down');
});

test('boost is cut in the air, while tumbling and when wiped out, without costing meter', () => {
  const m = full();
  m.update(STEP, true);
  const before = m.value;
  m.update(STEP, true, false);
  assert.equal(m.active, false);
  assert.equal(m.value, before);
  m.update(STEP, true, true); // landed with the button still down
  assert.equal(m.active, true);
});

console.log('\n=== boost speed model ===');
function ride(player: Player, meter: BoostMeter, held: boolean): void {
  meter.update(STEP, held, !player.wipedOut && !player.tumbling && !player.airborne);
  player.update(STEP, meter.active);
}

test('unboosted riding is unchanged: accelerate to MAX_SPEED and stay', () => {
  const p = new Player();
  for (let i = 0; i < 60; i++) p.update(STEP);
  near(p.speed, PLAYER_ACCEL * 1, 1e-6);
  for (let i = 0; i < 300; i++) p.update(STEP);
  assert.equal(p.speed, MAX_SPEED);
  const q = new Player();
  for (let i = 0; i < 300; i++) q.update(STEP, false);
  assert.equal(q.speed, MAX_SPEED);
});

test('boost raises the cap to MAX_SPEED x BOOST_SPEED_FACTOR and doubles acceleration', () => {
  const plain = new Player(), boosted = new Player(), meter = full();
  for (let i = 0; i < 30; i++) { plain.update(STEP); ride(boosted, meter, true); }
  near(boosted.speed, 2 * plain.speed, 1e-6, 'doubled acceleration from rest');
  assert.equal(BOOST_ACCEL_FACTOR, 2);
  const p = new Player(); p.speed = MAX_SPEED;
  const m = full();
  for (let i = 0; i < 100; i++) ride(p, m, true);
  assert.equal(p.speed, MAX_SPEED * BOOST_SPEED_FACTOR);
});

test('speed above MAX_SPEED decays over ~BOOST_DECAY_MS after boost, with no snap', () => {
  const p = new Player(); p.speed = MAX_SPEED * BOOST_SPEED_FACTOR;
  const m = new BoostMeter();
  let steps = 0, last = p.speed, biggestDrop = 0;
  while (p.speed > MAX_SPEED) {
    ride(p, m, false);
    biggestDrop = Math.max(biggestDrop, last - p.speed);
    assert.ok(p.speed <= last);
    last = p.speed; steps++;
    assert.ok(steps < 200);
  }
  near(steps * STEP, BOOST_DECAY_MS, 2 * STEP, 'decay time');
  assert.ok(biggestDrop < MAX_SPEED * (BOOST_SPEED_FACTOR - 1) / 5, 'decay is gradual');
  assert.equal(p.speed, MAX_SPEED);
});

test('no boost while wiped out or tumbling', () => {
  const wiped = new Player(); wiped.speed = MAX_SPEED; wiped.crashIntoTree(); wiped.crashIntoTree();
  const mw = full();
  for (let i = 0; i < 30; i++) ride(wiped, mw, true);
  assert.equal(wiped.speed, 0);
  assert.equal(mw.active, false);
  const tumbler = new Player(); tumbler.speed = MAX_SPEED * BOOST_SPEED_FACTOR; tumbler.hitRock();
  const mt = full();
  const post = tumbler.speed;
  assert.ok(post <= MAX_SPEED);
  for (let i = 0; i < 30; i++) ride(tumbler, mt, true);
  assert.ok(tumbler.speed <= MAX_SPEED && tumbler.tumbling);
  assert.equal(mt.active, false);
  assert.equal(mt.value, BOOST_MAX, 'meter is not burned while boost is unavailable');
});

console.log('\n=== boost safety against the placement model ===');
test('lane-change distance at boost speed still fits LANE_CHANGE_SEGMENTS', () => {
  assert.ok(MAX_SPEED * BOOST_SPEED_FACTOR * LANE_TWEEN_MS / 1000 < LANE_CHANGE_SEGMENTS * SEGMENT_LENGTH);
  assert.ok(BOOST_SPEED_FACTOR < 1.3, 'raising the factor needs a new placement model');
});

test('the landing-zone guarantees would be broken by a boosted jump, so jumps never keep boost speed', () => {
  // This is why Player.jump caps speed: unboosted reach is exactly the model's.
  const reach = (speed: number, ms: number) => speed * ms / 1000 / SEGMENT_LENGTH;
  assert.equal(reach(MAX_SPEED, JUMP_AIRTIME_MS), JUMP_REACH_NORMAL);
  assert.equal(reach(MAX_SPEED, JUMP_AIRTIME_EXTENDED_MS), JUMP_REACH_EXTENDED);
  assert.ok(reach(MAX_SPEED * BOOST_SPEED_FACTOR, JUMP_AIRTIME_EXTENDED_MS) > BLIND_LANDING_SEGMENTS);
  assert.ok(reach(MAX_SPEED * BOOST_SPEED_FACTOR, JUMP_AIRTIME_MS) > JUMP_REACH_NORMAL);
  for (const extended of [false, true]) {
    const p = new Player(), m = full();
    p.speed = MAX_SPEED * BOOST_SPEED_FACTOR;
    for (let i = 0; i < 5; i++) ride(p, m, true);
    assert.equal(m.active, true);
    p.jump(extended);
    assert.equal(p.speed, MAX_SPEED, 'takeoff speed is capped');
    const startZ = p.worldZ;
    while (p.airborne) ride(p, m, true);
    assert.equal(m.active, false, 'boost is cut while airborne');
    const segments = (p.worldZ - startZ) / SEGMENT_LENGTH;
    const limit = extended ? JUMP_REACH_EXTENDED : JUMP_REACH_NORMAL;
    assert.ok(segments <= limit + STEP_SLACK && segments > limit - 0.3, `${extended ? 'extended' : 'normal'} reach ${segments} within ${limit}`);
    assert.ok(extended ? segments <= BLIND_LANDING_SEGMENTS : true);
  }
});

console.log('\n=== combat tie ===');
test('a boosting player wins unarmed exchanges against rivals at their fastest cruise; without boost a faster rival takes the initiative', () => {
  const play = (playerSpeed: number) => {
    setDeterministicRuntime(5);
    const player = new Player(); player.worldZ = 10000; player.speed = playerSpeed;
    const rider = new AIRider({ cruiseSpeedFactor: 1.05, aggression: 0, reactionDistanceSegments: 8,
      startLane: 2, startZOffset: 10050, paletteIndex: 0, personality: 'bully', behaviorSeed: 3 });
    rider.speed = MAX_SPEED * 1.05;
    const combat = new CombatSystem(player, [rider], []);
    combat.update(STEP, 1000);
    return { player, rider, combat };
  };
  const boosted = play(MAX_SPEED * BOOST_SPEED_FACTOR);
  assert.equal(boosted.player.hitReacting, false);
  assert.ok(boosted.combat.events.some(e => e.type === 'brush'), 'boosting player wins the contact');
  const plain = play(MAX_SPEED);
  assert.ok(!plain.combat.events.some(e => e.type === 'brush'), 'at MAX_SPEED the player does not win the contact');
  assert.equal(plain.rider.attackPhase, 'windup', 'the faster rival takes the initiative instead');
});

console.log('\n=== determinism: boosted full-course runs ===');
function drive(player: Player, obstacles: Obstacle[]): void {
  if (player.wipedOut || player.airborne || player.tumbling || player.swinging || player.leanDirection) return;
  const nearest = (lane: number) => obstacles.filter(o => o.lane === lane && o.z >= player.worldZ - 100)
    .reduce<Obstacle | null>((best, o) => !best || o.z < best.z ? o : best, null);
  const current = nearest(player.laneIndex);
  if (!current || current.z - player.worldZ > 1400) return;
  const candidates = [player.laneIndex - 1, player.laneIndex + 1].filter(l => l >= 0 && l < 5)
    .map(lane => ({ lane, clearance: (nearest(lane)?.z ?? Infinity) - player.worldZ }))
    .sort((a, b) => b.clearance - a.clearance);
  if (candidates[0]?.clearance > 1000) {
    player.requestLaneShift(candidates[0].lane > player.laneIndex ? 1 : -1);
  } else if (current.kind !== 'tree' && current.z - player.worldZ < 420 &&
      !obstacles.some(o => o.kind === 'tree' && o.lane === player.laneIndex && o.z > player.worldZ && o.z < player.worldZ + 4000)) {
    player.jump(isMogulLaunchAvailable(player, obstacles));
  }
}

function race(seed: number, useBoost: boolean) {
  setDeterministicRuntime(seed * 997);
  const generated = generateTrack(seed);
  const { obstacles } = generated;
  const player = new Player(), meter = new BoostMeter();
  const riders = generated.aiRiders.map(p => new AIRider(p));
  const aiCollisions = riders.map(() => new CollisionSystem());
  const collisions = new CollisionSystem();
  const combat = new CombatSystem(player, riders, obstacles);
  const score = new ScoreTracker(player, riders, obstacles, collisions, combat);
  const finishZ = generated.segments[generated.segments.length - 1].z;
  const crests = generated.crestApexes.map(i => i * SEGMENT_LENGTH + SEGMENT_LENGTH / 2);
  let activeSteps = 0, peakSpeed = 0, airborneMax = 0, gained = 0, jumpStart = 0, worstReach = 0, time = 0;
  const trace: number[] = [];
  let wasAirborne = false;
  for (let step = 1; step <= 60 * 240; step++) {
    time = step * STEP;
    drive(player, obstacles);
    if (time % 1200 < STEP && !obstacles.some(o => o.lane === player.laneIndex && o.z > player.worldZ && o.z < player.worldZ + 1800)) combat.attemptAttack(time);
    // Hold boost whenever the meter allows it.
    meter.update(STEP, useBoost, !player.wipedOut && !player.tumbling && !player.airborne);
    const prevZ = player.worldZ;
    player.update(STEP, meter.active, surfaceAtZ(generated.segments, player.worldZ));
    if (crests.some(z => prevZ < z && player.worldZ >= z)) player.jump(true, false);
    if (player.airborne && !wasAirborne) jumpStart = player.worldZ;
    if (player.airborne) airborneMax = Math.max(airborneMax, player.speed);
    if (!player.airborne && wasAirborne) worstReach = Math.max(worstReach, (player.worldZ - jumpStart) / SEGMENT_LENGTH);
    wasAirborne = player.airborne;
    collisions.update(player, obstacles);
    riders.forEach((r, i) => {
      r.update(STEP, obstacles, player, surfaceAtZ(generated.segments, r.worldZ), chuteAhead(generated.segments, r.worldZ));
      if (r.finishTimeMs === null && r.worldZ >= finishZ) r.finishTimeMs = time;
      if (r.finishTimeMs !== null) r.worldZ = finishZ;
      aiCollisions[i].update(r, obstacles);
    });
    combat.update(STEP, time);
    const counter = combat.skillEvents.some(e => e.type === 'counter');
    combat.skillEvents.length = 0;
    score.update(STEP);
    const before = meter.value;
    meter.addFeedback(score.feedback.map(e => e.kind), counter);
    gained += meter.value - before;
    meter.observe(player);
    if (meter.active) activeSteps++;
    peakSpeed = Math.max(peakSpeed, player.speed);
    if (step % 30 === 0) trace.push(Math.round(player.worldZ), Math.round(player.speed), Math.round(meter.value * 100));
    if (player.wipedOut || player.worldZ >= finishZ) break;
  }
  return { seed, finished: !player.wipedOut, timeS: time / 1000, activeSteps, peakSpeed, airborneMax, worstReach, gained,
    points: score.runningScore, trace: trace.join(',') };
}

const SEEDS = [1, 2, 3, 7, 11, 21, 42, 77, 101, 202, 333, 777];
const boostedRuns = SEEDS.map(s => race(s, true));
const plainRuns = SEEDS.map(s => race(s, false));
test('same seed gives an identical boosted run (positions, speeds, meter, score)', () => {
  for (const seed of [7, 42, 202]) assert.deepEqual(race(seed, true), boostedRuns[SEEDS.indexOf(seed)]);
});
test('boosted runs actually boost, earn from play, and never carry boost speed through a jump', () => {
  assert.ok(boostedRuns.some(r => r.activeSteps > 0), 'meter was earned and spent');
  assert.ok(boostedRuns.some(r => r.peakSpeed > MAX_SPEED));
  assert.ok(boostedRuns.every(r => r.peakSpeed <= MAX_SPEED * BOOST_SPEED_FACTOR));
  for (const r of boostedRuns) {
    assert.ok(r.airborneMax <= MAX_SPEED, `seed ${r.seed}: airborne speed ${r.airborneMax}`);
    assert.ok(r.worstReach <= JUMP_REACH_EXTENDED + STEP_SLACK, `seed ${r.seed}: jump travelled ${r.worstReach} segments`);
  }
  assert.ok(plainRuns.every(r => r.peakSpeed <= MAX_SPEED && r.activeSteps === 0));
});

const finishers = (runs: ReturnType<typeof race>[]) => runs.filter(r => r.finished);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\n  par ${PAR_TIME}s | plain finishers ${finishers(plainRuns).length}/${SEEDS.length}, mean ${mean(finishers(plainRuns).map(r => r.timeS)).toFixed(1)}s`
  + ` | boosted finishers ${finishers(boostedRuns).length}/${SEEDS.length}, mean ${mean(finishers(boostedRuns).map(r => r.timeS)).toFixed(1)}s`
  + `, active ${(mean(boostedRuns.map(r => r.activeSteps)) * STEP / 1000).toFixed(1)}s/run`);
test('boost shortens runs but not beyond a sensible fraction of par', () => {
  const p = mean(finishers(plainRuns).map(r => r.timeS)), b = mean(finishers(boostedRuns).map(r => r.timeS));
  assert.ok(b <= p, 'boost never slows the typical run');
  assert.ok(b > p * 0.8, 'boost is a bonus, not a different game');
});

console.log(`\n${passed} boost checks passed`);
