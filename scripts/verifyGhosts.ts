/** Ghost/date contracts and deterministic, production-model fixed-step replay. */
import assert from 'node:assert/strict';
import {
  challengeUrl, CheckpointTracker, checkpointWorldZs, COURSE_VERSION, createGhostStore,
  createQuickRace, cupRivalParams, dailyRace, dailySeed, FIXED_STEP_MS, FixedRaceClock, GhostRecorder,
  ghostTimeAtZ, MAX_GHOST_CHARACTERS, MAX_GHOST_COURSES, MAX_GHOST_SAMPLES, parseChallenge,
  parseGhost, retryRace, rivalSeed, RULES_VERSION, sampleGhost, shareResultText, utcDate, validDailyDate,
  type GhostPose, type GhostRecording
} from '../src/progression';
import { AIRider } from '../src/entities/aiRider';
import { Player } from '../src/entities/player';
import { generateTrack } from '../src/track/generator';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import { runtimeRandom, setDeterministicRuntime } from '../src/entities/runtimeRng';
import type { ValueStore } from '../src/progression/persistence';
let passed = 0;
const check = (name: string, run: () => void) => { run(); passed++; console.log(`  PASS ${name}`); };
function storage(raw: string | null = null) {
  let value = raw;
  let blocked = false;
  const store: ValueStore = { get: () => { if (blocked) throw Error('unavailable'); return value; },
    set: next => { if (blocked) throw Error('quota'); value = next; } };
  return { store, read: () => value, block: () => { blocked = true; } };
}
const pose = (worldZ: number, laneOffset = 0, jumpHeight = 0): GhostPose => ({ worldZ, laneOffset, jumpHeight, lean: 0 });
function recording(seed = 123, time = 1000): GhostRecording {
  const recorder = new GhostRecorder(seed, 1000);
  recorder.capture(0, pose(0));
  for (let tick = 1; tick < 10; tick++) recorder.capture(time * tick / 10, pose(tick * 100, tick / 10, tick % 2));
  return recorder.finish(time, pose(1000), true)!;
}
console.log('\n=== ghosts, daily challenges, and fixed simulation ===');
check('successful capture contains start and finish poses with exact rules/course identity', () => {
  const ghost = recording();
  assert.ok(ghost);
  assert.equal(ghost.samples[0][0], 0);
  assert.equal(ghost.samples.at(-1)![0], 1000);
  assert.equal(ghost.rulesVersion, RULES_VERSION);
  assert.equal(ghost.courseVersion, COURSE_VERSION);
  assert.equal(ghost.finishTimeMs, 1000);
});
check('unfinished, invalid, late-start and reused recorders cannot produce a ghost', () => {
  const recorder = new GhostRecorder(1, 1000);
  recorder.capture(0, pose(0));
  assert.equal(recorder.finish(1000, pose(1000), false), null);
  assert.equal(recorder.finish(1000, pose(1000), true), null);
  const bad = new GhostRecorder(1, 1000); bad.capture(0, pose(0)); bad.capture(100, pose(NaN));
  assert.equal(bad.finish(1000, pose(1000), true), null);
  const late = new GhostRecorder(1, 1000); late.capture(10, pose(0));
  assert.equal(late.finish(1000, pose(1000), true), null);
});
check('interpolation is bounded, smooth, read-only and hides the finished ghost', () => {
  const ghost = recording();
  const before = JSON.stringify(ghost);
  assert.equal(sampleGhost(ghost, 0)!.worldZ, 0);
  assert.equal(sampleGhost(ghost, 150)!.worldZ, 150);
  assert.ok(Math.abs(sampleGhost(ghost, 150)!.laneOffset - 0.15) < 1e-9);
  assert.equal(sampleGhost(ghost, 150)!.jumpHeight, 0.5);
  assert.equal(sampleGhost(ghost, 1000)!.worldZ, 1000);
  assert.equal(sampleGhost(ghost, 1001), null);
  assert.equal(sampleGhost(ghost, NaN), null);
  assert.equal(JSON.stringify(ghost), before);
});
check('checkpoints report accurate signed delta and one-shot first crossings', () => {
  const ghost = recording();
  const tracker = new CheckpointTracker(checkpointWorldZs(0, 1000));
  assert.deepEqual(tracker.positions, [250, 500, 750]);
  const first = tracker.update(200, 300, 210, 330, ghost);
  assert.equal(first[0].timeMs, 270);
  assert.equal(first[0].ghostTimeMs, 250);
  assert.equal(first[0].deltaMs, 20);
  assert.equal(tracker.update(300, 200, 330, 400, ghost).length, 0);
  assert.equal(tracker.update(200, 300, 400, 500, ghost).length, 0);
  const rest = tracker.update(300, 800, 500, 700, ghost);
  assert.equal(rest.length, 2);
  assert.ok(rest[1].deltaMs! < 0);
  assert.equal(tracker.latest!.index, 2);
});
check('ghost split uses first crossing even after a knockback and recrossing', () => {
  const ghost = recording();
  ghost.samples = [[0, 0, 0, 0, 0], [100, 400, 0, 0, 0], [200, 200, 0, 0, 0], [300, 600, 0, 0, 0], [1000, 1000, 0, 0, 0]];
  assert.equal(ghostTimeAtZ(ghost, 300), 75);
  assert.equal(ghostTimeAtZ(ghost, 1001), null);
});
check('invalid/old/incompatible/unbounded ghost payloads fail closed', () => {
  const original = recording();
  for (const patch of [{ version: 0 }, { rulesVersion: 'old' }, { courseVersion: 'old' }, { seed: -1 }, { finishTimeMs: NaN }, { samples: [] }, { samples: Array(MAX_GHOST_SAMPLES + 1).fill(original.samples[0]) }]) {
    assert.equal(parseGhost({ ...original, ...patch }), null);
  }
  assert.equal(parseGhost(original, 999), null);
  assert.equal(parseGhost({ ...original, samples: [[0, 0, 0, 0, 0], [0, 1000, 0, 0, 0]] }), null);
  assert.equal(parseGhost({ ...original, samples: [[0, 0, 0, 0, 0], [1000, 1000, 5, 0, 0]] }), null);
});
check('slow runs compact samples without losing the start/end or exceeding the cap', () => {
  const recorder = new GhostRecorder(1, 500000);
  recorder.capture(0, pose(0));
  for (let time = 100; time < 500000; time += 100) recorder.capture(time, pose(time));
  const ghost = recorder.finish(500000, pose(500000), true)!;
  assert.ok(ghost);
  assert.ok(ghost.samples.length <= MAX_GHOST_SAMPLES);
  assert.equal(ghost.samples[0][0], 0);
  assert.equal(ghost.samples.at(-1)![0], 500000);
  assert.equal(sampleGhost(ghost, 100000)!.worldZ, 100000);
});
check('best-finish persistence is seed/rules scoped and survives reloads', () => {
  const memory = storage();
  const ghosts = createGhostStore(memory.store);
  const options = createQuickRace(123);
  assert.equal(ghosts.saveGhost(options, recording()), true);
  assert.equal(ghosts.saveGhost(options, recording(123, 2000)), false);
  assert.equal(ghosts.saveGhost(options, recording(123, 900)), true);
  assert.equal(ghosts.saveGhost(options, recording(124, 800)), false);
  assert.equal(createGhostStore(memory.store).loadGhost(123)!.finishTimeMs, 900);
  assert.equal(ghosts.loadGhost(999), null);
});
check('practice never overwrites competitive ghosts; successful ghost remains available to practice', () => {
  const ghosts = createGhostStore(storage().store);
  const options = createQuickRace(123);
  ghosts.saveGhost(options, recording());
  assert.equal(ghosts.saveGhost({ ...options, mode: 'practice' }, recording(123, 700)), false);
  assert.equal(ghosts.loadGhost(123)!.finishTimeMs, 1000);
});
check('ghost course and serialized-size caps prevent unbounded local/native storage', () => {
  const memory = storage();
  let now = 0;
  const ghosts = createGhostStore(memory.store, () => ++now);
  for (let index = 0; index < MAX_GHOST_COURSES + 5; index++) ghosts.saveGhost(createQuickRace(index), recording(index));
  assert.ok(memory.read()!.length <= MAX_GHOST_CHARACTERS);
  assert.equal(Object.keys(JSON.parse(memory.read()!).recordings).length, MAX_GHOST_COURSES);
  assert.equal(ghosts.loadGhost(0), null);
  assert.ok(ghosts.loadGhost(MAX_GHOST_COURSES + 4));
});
check('corrupt, full and unavailable storage fail safely and retain session bests', () => {
  for (const raw of ['{bad', 'x'.repeat(MAX_GHOST_CHARACTERS + 1), JSON.stringify({ version: 2 }), 'null']) {
    const ghosts = createGhostStore(storage(raw).store);
    assert.equal(ghosts.loadGhost(123), null);
    assert.equal(ghosts.saveGhost(createQuickRace(123), recording()), true);
  }
  const memory = storage(); const ghosts = createGhostStore(memory.store);
  ghosts.saveGhost(createQuickRace(123), recording());
  memory.block();
  assert.equal(ghosts.saveGhost(createQuickRace(123), recording(123, 800)), true);
  assert.equal(ghosts.loadGhost(123)!.finishTimeMs, 800);
});
check('UTC dates and leap-day validation ignore local zone/DST boundaries', () => {
  assert.equal(utcDate(new Date('2026-10-09T23:59:59.999Z')), '2026-10-09');
  assert.equal(utcDate(new Date('2026-10-10T00:00:00Z')), '2026-10-10');
  assert.equal(utcDate(new Date('2026-10-09T19:00:00-07:00')), '2026-10-10');
  assert.equal(validDailyDate('2028-02-29'), true);
  assert.equal(validDailyDate('2026-02-29'), false);
  assert.equal(validDailyDate('2026-13-01'), false);
  assert.equal(validDailyDate('2026-1-01'), false);
  assert.equal(dailySeed('2026-10-09'), dailySeed('2026-10-09'));
  assert.notEqual(dailySeed('2026-10-09'), dailySeed('2026-10-10'));
});
check('share links reproduce current daily challenge; historical links become clearly labelled practice', () => {
  const options = dailyRace('2026-10-09');
  const link = challengeUrl(options, 'https://example.com/game?debug=true#private');
  const url = new URL(link);
  assert.equal(url.searchParams.has('debug'), false);
  assert.equal(url.hash, '');
  const current = parseChallenge(url.search, '2026-10-09')!;
  assert.equal(current.seed, options.seed);
  assert.equal(current.mode, 'daily');
  assert.equal(parseChallenge(url.search, '2026-10-10')!.mode, 'practice');
  assert.equal(parseChallenge(url.search.replace(RULES_VERSION, 'old'), '2026-10-09'), null);
  assert.equal(parseChallenge(url.search.replace(`seed=${options.seed}`, 'seed=1'), '2026-10-09'), null);
  assert.equal(parseChallenge('?daily=2026-10-09', '2026-10-09'), null);
  assert.equal(challengeUrl(options, 'capacitor://localhost/'), '');
});
check('central retry demotes stale UTC daily attempts but preserves seed/date and cup identity', () => {
  const options = dailyRace('2026-10-09');
  const sameDay = retryRace(options, '2026-10-09');
  assert.equal(sameDay.mode, 'daily');
  assert.notEqual(sameDay.runId, options.runId);
  const afterMidnight = retryRace(options, '2026-10-10');
  assert.equal(afterMidnight.mode, 'practice');
  assert.equal(afterMidnight.seed, options.seed);
  assert.equal(afterMidnight.dailyDate, '2026-10-09');
  assert.equal(retryRace(afterMidnight, '2026-10-10').mode, 'practice');
  const cup = { mode: 'cup' as const, seed: 1, runId: 'cup-one:round-0', cupId: 'cup-one', roundIndex: 0 };
  assert.deepEqual(retryRace(cup, '2026-10-10'), cup);
});
check('share text includes reproducible date/seed/versions and self-reported disclosure; native text remains useful', () => {
  const options = dailyRace('2026-10-09');
  const summary = { finished: true, total: 15000, finishTimeSeconds: 72.123, position: 2 };
  const text = shareResultText(options, summary, 'capacitor://localhost/');
  for (const expected of ['2026-10-09', String(options.seed), RULES_VERSION, COURSE_VERSION, 'Self-reported', 'No online leaderboard', '72.12s']) assert.ok(text.includes(expected));
  assert.ok(!text.includes('capacitor://'));
  assert.ok(shareResultText({ ...options, mode: 'practice' }, summary).includes('(practice)'));
});
check('fixed clock is exact across frame rates, excludes paused time, bounds stalls and resets retries', () => {
  const total = (fps: number): number => {
    const clock = new FixedRaceClock();
    for (let frame = 0; frame < fps * 10; frame++) clock.advance(1000 / fps, () => {});
    return clock.elapsedMs;
  };
  assert.equal(total(30), 10000);
  assert.equal(total(60), 10000);
  assert.equal(total(144), 10000);
  const clock = new FixedRaceClock();
  clock.advance(10, () => {}); clock.discardPending();
  clock.advance(FIXED_STEP_MS, () => {});
  assert.equal(clock.elapsedMs, FIXED_STEP_MS);
  const count = clock.advance(1000000, () => {});
  assert.equal(count, 15);
  clock.reset(); assert.equal(clock.elapsedMs, 0);
  assert.equal(clock.advance(NaN, () => {}), 0);
  assert.equal(clock.advance(100, () => false), 1);
});
check('recording/interpolation/split reads consume no combat RNG and mutate no recording', () => {
  const ghost = recording();
  setDeterministicRuntime(11);
  const expected = Array.from({ length: 100 }, () => runtimeRandom());
  setDeterministicRuntime(11);
  const actual = Array.from({ length: 100 }, (_, index) => {
    sampleGhost(ghost, index * 10); ghostTimeAtZ(ghost, index * 10); return runtimeRandom();
  });
  assert.deepEqual(actual, expected);
});
check('identical tick inputs replay production player/rivals/combat identically at 30,60,144Hz', () => {
  function replay(fps: number) {
    const seed = dailySeed('2026-10-09');
    setDeterministicRuntime(rivalSeed(seed));
    const track = generateTrack(seed);
    const player = new Player();
    const rivals = track.aiRiders.map((params, index) => new AIRider(cupRivalParams(index, params)));
    const combat = new CombatSystem(player, rivals, track.obstacles);
    const collisions = new CollisionSystem();
    const rivalCollisions = rivals.map(() => new CollisionSystem());
    const clock = new FixedRaceClock();
    let tick = 0;
    for (let frame = 0; frame < fps * 12; frame++) clock.advance(1000 / fps, (dt, elapsed) => {
      tick++;
      if (tick % 70 === 0) player.jump(false);
      player.update(dt);
      for (const rider of rivals) rider.update(dt, track.obstacles, player);
      collisions.update(player, track.obstacles);
      rivals.forEach((rider, index) => rivalCollisions[index].update(rider, track.obstacles));
      combat.update(dt, elapsed);
    });
    return { tick, elapsed: clock.elapsedMs, player: { worldZ: player.worldZ, speed: player.speed, lane: player.laneIndex, wipedOut: player.wipedOut },
      rivals: rivals.map(rider => ({ z: rider.worldZ, speed: rider.speed, lane: rider.laneIndex, wipedOut: rider.wipedOut })), random: runtimeRandom() };
  }
  assert.deepEqual(replay(30), replay(60));
  assert.deepEqual(replay(144), replay(60));
});
setDeterministicRuntime(null);
console.log(`\n${passed} ghost/daily/fixed-step checks passed.`);
