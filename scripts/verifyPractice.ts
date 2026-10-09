import assert from 'node:assert/strict';
import { PracticeObjectives } from '../src/practice/lessons';
import { AIRider } from '../src/entities/aiRider';
import { Player } from '../src/entities/player';
import { CombatSystem } from '../src/entities/combat';
import { CollisionSystem, isMogulLaunchAvailable } from '../src/entities/collision';
import { MAX_SPEED, PLAYER_START_Z, SEGMENT_LENGTH } from '../src/config';
import type { Obstacle } from '../src/entities/obstacle';
const dt = 1000 / 60;
for (const lesson of [0, 1, 2]) {
  const objective = new PracticeObjectives(lesson);
  const player = new Player(); player.speed = MAX_SPEED;
  const personality = (['bully', 'line-defender', 'daredevil'] as const)[lesson];
  const rider = new AIRider({ personality, behaviorSeed: 700 + lesson, paletteIndex: 0,
    reactionDistanceSegments: 7, startLane: lesson === 1 ? 2 : 1,
    startZOffset: PLAYER_START_Z + (lesson === 1 ? 600 : lesson === 2 ? 700 : 90),
    aggression: lesson === 0 ? 0 : 0.9, cruiseSpeedFactor: lesson === 1 ? 0.92 : 1 });
  rider.speed = MAX_SPEED * rider.params.cruiseSpeedFactor;
  const z = PLAYER_START_Z + 5400;
  const obstacles: Obstacle[] = lesson === 2 ? [
    { kind: 'mogul', lane: 2, z, segIndex: Math.floor(z / SEGMENT_LENGTH) },
    { kind: 'mogul', lane: 1, z: z - 200, segIndex: Math.floor((z - 200) / SEGMENT_LENGTH) }
  ] : [];
  const collisions = new CollisionSystem(), rivalCollisions = new CollisionSystem();
  const combat = new CombatSystem(player, [rider], obstacles);
  let launched = false, observedDaredevilAir = false;
  for (let time = dt; time <= 8500 && !objective.complete; time += dt) {
    if (lesson === 0 && rider.attackPhase === 'windup' && rider.attackProgress > 0.7 && player.canJump) player.requestJump();
    if (lesson === 0 && combat.counterReady) combat.attemptAttack(time);
    if (lesson === 1 && time < dt * 2) player.requestLaneShift(1);
    if (lesson === 2 && isMogulLaunchAvailable(player, obstacles) && player.canJump) player.jump(true);
    player.update(dt); rider.update(dt, obstacles, player);
    collisions.update(player, obstacles); rivalCollisions.update(rider, obstacles);
    combat.update(dt, time);
    for (const event of combat.skillEvents.splice(0)) objective.combat(event.type);
    combat.events.length = 0;
    if (lesson === 0 && !launched && time >= 850) launched = rider.requestTelegraphedAttack(player);
    if (lesson === 1 && player.worldZ > rider.worldZ + 160 && Math.abs(player.laneOffsetFraction - rider.laneOffsetFraction) >= 0.35) objective.passed = true;
    if (lesson === 2) {
      observedDaredevilAir ||= rider.airborne;
      if (player.airborne && player.extendedJump && player.worldZ >= z - 800) objective.jumped = true;
      if (objective.jumped && !player.airborne && player.worldZ > z && !player.stumbling) objective.landed = true;
    }
  }
  assert.ok(objective.complete, `lesson ${lesson + 1} is completable through actual controls and model events`);
  if (lesson === 2) assert.ok(observedDaredevilAir, 'daredevil actually demonstrates a jump');
  assert.equal(player.wipedOut, false);
}
const objective = new PracticeObjectives(0); objective.combat('counter'); assert.equal(objective.complete, false, 'counter alone is not an evade lesson completion');
console.log('PASS all three practice lessons complete through real model controls; objective order and rival demonstration verified');
