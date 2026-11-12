import assert from 'node:assert/strict';
import { PRACTICE_LESSON_COUNT, PRACTICE_LESSONS, PRACTICE_SHOVE_WINDOW_MS, PracticeObjectives } from '../src/practice/lessons';
import { AIRider } from '../src/entities/aiRider';
import { Player } from '../src/entities/player';
import { CombatSystem } from '../src/entities/combat';
import { CollisionSystem, isMogulLaunchAvailable } from '../src/entities/collision';
import { MAX_SPEED, PLAYER_START_Z, SEGMENT_LENGTH } from '../src/config';
import type { Obstacle } from '../src/entities/obstacle';
import { cupRivalParams } from '../src/progression/cup';
import { generateTrack } from '../src/track/generator';
const dt = 1000 / 60;
assert.equal(PRACTICE_LESSON_COUNT, 4);
assert.ok(PRACTICE_LESSONS.every((l, i) => l.title.startsWith(`${i + 1} / 4`)), 'titles read n / 4');
// The touch layout has no separate SHOVE button, so its lesson wording must not tell the player to press one.
assert.ok(!/G \/ L/.test(PRACTICE_LESSONS[3].touchInstruction ?? '') && /SHOVE/.test(PRACTICE_LESSONS[3].touchInstruction ?? '') && /button/i.test(PRACTICE_LESSONS[3].touchInstruction ?? ''), 'lesson 4 touch text describes the one button');
assert.ok(!/G \/ L/.test(PRACTICE_LESSONS[3].touchHint ?? '') && !/G \/ L/.test(PRACTICE_LESSONS[3].touchRetry ?? ''), 'lesson 4 touch hint and retry text name no key');
// Every lesson is completable with the keyboard actions and again with the single touch button.
for (const touch of [false, true]) for (const lesson of [0, 1, 2, 3]) {
  const objective = new PracticeObjectives(lesson);
  const player = new Player(); player.speed = MAX_SPEED;
  const personality = (['bully', 'line-defender', 'daredevil', 'bully'] as const)[lesson];
  const rosterIndex = [1, 0, 3, 2][lesson];
  const template = cupRivalParams(rosterIndex, generateTrack(42).aiRiders[rosterIndex]);
  const rider = new AIRider({ ...template, personality, behaviorSeed: 700 + lesson, startLane: lesson === 1 ? 2 : 1,
    startZOffset: PLAYER_START_Z + (lesson === 1 ? 600 : lesson === 2 ? 700 : 90),
    ...(lesson === 3 ? { reactionDistanceSegments: 1 } : {}),
    aggression: lesson === 0 || lesson === 3 ? 0 : 0.9, cruiseSpeedFactor: lesson === 1 ? 0.92 : 1 });
  if (lesson < 3) assert.equal(rider.params.name, ['SLATE', 'NOVA', 'EMBER'][lesson]);
  else assert.ok(rider.params.name, 'the shove lesson uses a named roster rival');
  assert.equal(rider.params.paletteIndex, rosterIndex);
  rider.speed = MAX_SPEED * rider.params.cruiseSpeedFactor;
  const z = PLAYER_START_Z + 5400;
  const obstacles: Obstacle[] = lesson === 2 ? [
    { kind: 'mogul', lane: 2, z, segIndex: Math.floor(z / SEGMENT_LENGTH) },
    { kind: 'mogul', lane: 1, z: z - 200, segIndex: Math.floor((z - 200) / SEGMENT_LENGTH) }
  ] : lesson === 3 ? [{ kind: 'rock', lane: 0, z: PLAYER_START_Z + 10500, segIndex: Math.floor((PLAYER_START_Z + 10500) / SEGMENT_LENGTH) }] : [];
  let rockHits = 0;
  const collisions = new CollisionSystem(), rivalCollisions = new CollisionSystem();
  const combat = new CombatSystem(player, [rider], obstacles);
  let launched = false, observedDaredevilAir = false;
  for (let time = dt; time <= 8500 && !objective.complete; time += dt) {
    if (lesson === 0 && rider.attackPhase === 'windup' && rider.attackProgress > 0.7 && player.canJump) player.requestJump();
    if (lesson === 0 && combat.counterReady) { if (touch) { assert.equal(combat.strikeIntent(0), 'attack', 'touch: a counter window reads HIT'); combat.attemptStrike(time, 0); } else combat.attemptAttack(time); }
    if (lesson === 1 && time < dt * 2) player.requestLaneShift(1);
    if (lesson === 2 && isMogulLaunchAvailable(player, obstacles) && player.canJump) player.jump(true);
    // Real play: wait for the "!" cue (tree/rock waiting in the destination lane), then press SHOVE.
    if (lesson === 3) {
      const target = combat.pushTarget;
      if (target && combat.pushPlan(target, 0).hazard === 'rock') {
        if (touch) { assert.equal(combat.strikeIntent(0), 'shove', 'touch: at the rock cue the one button is SHOVE'); combat.attemptStrike(time, 0); }
        else combat.attemptPush(time, 0);
      }
    }
    player.update(dt); rider.update(dt, obstacles, player);
    collisions.update(player, obstacles); rivalCollisions.update(rider, obstacles);
    combat.update(dt, time);
    for (const event of combat.skillEvents.splice(0)) objective.combat(event.type);
    if (lesson === 3) {
      if (combat.events.some((event) => event.type === 'push')) objective.shoved(time);
      if (rider.rockHitSerial > rockHits) objective.rivalHitRock(time);
      rockHits = rider.rockHitSerial;
    }
    combat.events.length = 0;
    if (lesson === 0 && !launched && time >= 850) launched = rider.requestTelegraphedAttack(player);
    if (lesson === 1 && player.worldZ > rider.worldZ + 160 && Math.abs(player.laneOffsetFraction - rider.laneOffsetFraction) >= 0.35) objective.passed = true;
    if (lesson === 2) {
      observedDaredevilAir ||= rider.airborne;
      if (player.airborne && player.extendedJump && player.worldZ >= z - 800) objective.jumped = true;
      if (objective.jumped && !player.airborne && player.worldZ > z && !player.stumbling) objective.landed = true;
    }
  }
  assert.ok(objective.complete, `lesson ${lesson + 1} is completable through actual ${touch ? 'single-button touch' : 'keyboard'} controls and model events`);
  if (lesson === 3) assert.ok(rider.rockHitSerial === 1 && rider.laneIndex === 0, 'the rival was pushed into the rock');
  if (lesson === 2) assert.ok(observedDaredevilAir, 'daredevil actually demonstrates a jump');
  assert.equal(player.wipedOut, false);
}
{
  // Lesson 4 objective: the rock only counts shortly after a shove, in that order.
  const shove = new PracticeObjectives(3);
  shove.rivalHitRock(1000);
  assert.equal(shove.complete, false, 'a rock with no shove is not the lesson');
  shove.shoved(2000);
  shove.rivalHitRock(2000 + PRACTICE_SHOVE_WINDOW_MS + 1);
  assert.equal(shove.complete, false, 'a rock more than 2 s after the shove does not count');
  shove.rivalHitRock(2000 + PRACTICE_SHOVE_WINDOW_MS);
  assert.equal(shove.complete, true);
}
{
  // Without a shove the passive rival never reaches the rock lane: the lesson cannot complete by riding.
  const player = new Player(); player.speed = MAX_SPEED;
  const template = cupRivalParams(2, generateTrack(42).aiRiders[2]);
  const rider = new AIRider({ ...template, personality: 'bully', behaviorSeed: 703, startLane: 1, aggression: 0,
    reactionDistanceSegments: 1, startZOffset: PLAYER_START_Z + 90, cruiseSpeedFactor: 1 });
  rider.speed = MAX_SPEED;
  const rock: Obstacle = { kind: 'rock', lane: 0, z: PLAYER_START_Z + 10500, segIndex: 0 };
  const c = new CollisionSystem();
  for (let t = 0; t < 8500; t += dt) { player.update(dt); rider.update(dt, [rock], player); c.update(rider, [rock]); }
  assert.equal(rider.rockHitSerial, 0, 'the lesson needs the shove');
}
const objective = new PracticeObjectives(0); objective.combat('counter'); assert.equal(objective.complete, false, 'counter alone is not an evade lesson completion');
console.log('PASS all four practice lessons complete through real model controls; objective order and rival demonstration verified');
