/** Local model proof for the exact driver serialized into browser acceptance.
 * Uses real production entities and reproduces RaceScene.simulate ordering,
 * including its fixed-60 clock, combat freeze, pickups, recorder and splits.
 * This complements (does not replace) the actual RaceScene browser test.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SEGMENT_LENGTH } from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import { Player } from '../src/entities/player';
import { collectPickups } from '../src/entities/pickup';
import { ScoreTracker } from '../src/entities/scoring';
import { cupRivalParams } from '../src/progression/cup';
import { CheckpointTracker, GhostRecorder, checkpointWorldZs, type GhostRecording } from '../src/progression/ghost';
import { generateTrack } from '../src/track/generator';
// Plain JavaScript intentionally keeps the exact function browser-serializable.
// @ts-expect-error JavaScript acceptance helper is outside production tsconfig.
import { naturalRaceDriver } from './naturalRaceDriver.mjs';

function makeModel(seed: number, ghost: GhostRecording | null = null) {
  const generated = generateTrack(seed);
  const player = new Player();
  const aiRiders = generated.aiRiders.map((params, i) => new AIRider(cupRivalParams(i, params)));
  const collisions = new CollisionSystem();
  const aiCollisions = aiRiders.map(() => new CollisionSystem());
  const combat = new CombatSystem(player, aiRiders, generated.obstacles);
  const scoreTracker = new ScoreTracker(player, aiRiders, generated.obstacles, collisions, combat);
  const finishSegment = generated.segments.find(segment => segment.isFinish)!;
  const ghostRecorder = new GhostRecorder(seed, finishSegment.z);
  const pose = () => ({ worldZ: player.worldZ, laneOffset: player.laneOffsetFraction,
    jumpHeight: player.jumpArcHeight, lean: player.leanDirection });
  ghostRecorder.capture(0, pose());
  let prevWiped = false, prevTumbling = false;
  return {
    seed, options: { runId: `natural-${seed}` }, countdownMs: 0, practiceObjective: null,
    player, aiRiders, aiCollisions, collisions, combat, scoreTracker,
    obstacles: generated.obstacles, pickups: generated.pickups,
    crestApexZs: generated.crestApexes.map(index => index * SEGMENT_LENGTH + SEGMENT_LENGTH / 2),
    finishSegment, ghostRecorder, ghost, ghostSplit: '',
    checkpoints: new CheckpointTracker(checkpointWorldZs(player.worldZ, finishSegment.z)),
    elapsedRaceMs: 0, simulationHitStopMs: 0, raceOver: false, recording: null as GhostRecording | null,
    simulate(delta: number, _inputFrameElapsedMs: number) {
      this.elapsedRaceMs += delta;
      const time = this.elapsedRaceMs;
      if (this.simulationHitStopMs > 0) { this.simulationHitStopMs = Math.max(0, this.simulationHitStopMs - delta); return; }
      const previousZ = player.worldZ;
      player.update(delta);
      if (this.crestApexZs.some(z => previousZ < z && player.worldZ >= z)) player.jump(true, false);
      collisions.update(player, this.obstacles);
      aiRiders.forEach((rider, i) => {
        rider.update(delta, this.obstacles, player);
        if (rider.finishTimeMs === null && rider.worldZ >= finishSegment.z) rider.finishTimeMs = time;
        if (rider.finishTimeMs !== null) rider.worldZ = finishSegment.z;
        aiCollisions[i].update(rider, this.obstacles);
      });
      combat.update(delta, time);
      combat.skillEvents.length = 0;
      collectPickups(player, this.pickups);
      if (combat.events.length) this.simulationHitStopMs = Math.max(this.simulationHitStopMs, 50);
      if (player.wipedOut && !prevWiped) this.simulationHitStopMs = 133.33333333333334;
      else if (player.tumbling && !prevTumbling) this.simulationHitStopMs = 83.33333333333334;
      prevWiped = player.wipedOut; prevTumbling = player.tumbling;
      scoreTracker.update(delta);
      ghostRecorder.capture(time, pose());
      const splits = this.checkpoints.update(previousZ, player.worldZ, time - delta, time, ghost);
      if (splits.length) this.ghostSplit = JSON.stringify(splits.at(-1));
      if ((player.wipedOut && this.simulationHitStopMs <= 0) || player.worldZ >= finishSegment.z) {
        this.raceOver = true;
        this.recording = ghostRecorder.finish(time, pose(), !player.wipedOut);
      }
    }
  };
}
const seeds = (process.argv.find(arg => arg.startsWith('--seeds='))?.slice(8) ?? '1,2,3,7,11,21,42,77,101,202,333,777').split(',').map(Number);
const reports = seeds.map(seed => {
  const first = makeModel(seed);
  const run = naturalRaceDriver({ scene: first, render: false });
  if (!run.finished) return { ...run, replay: null };
  assert.ok(first.recording, `seed ${seed}: genuine complete ghost`);
  const replay = makeModel(seed, first.recording);
  const firstCheckpoint = naturalRaceDriver({ scene: replay, render: false, stopAtCheckpoint: 0 });
  assert.equal(firstCheckpoint.checkpoints.length, 1);
  assert.equal(firstCheckpoint.over, false);
  const result = naturalRaceDriver({ scene: replay, render: false });
  assert.equal(result.finished, true);
  assert.equal(result.elapsedMs, run.elapsedMs);
  assert.equal(result.checkpoints.length, 3);
  assert.ok(result.checkpoints.every((split: { deltaMs: number }) => Math.abs(split.deltaMs) < 0.01));
  assert.deepEqual(result.rivals, run.rivals);
  assert.equal(result.obstacles, run.obstacles);
  assert.ok(result.unchangedCourseAndRoster);
  return { ...run, replay: { finished: result.finished, elapsedMs: result.elapsedMs,
    ghostLoaded: result.ghostLoaded, checkpoints: result.checkpoints, ghostSamples: result.ghostSamples } };
});
mkdirSync('.verify', { recursive: true });
writeFileSync('.verify/natural-driver-model.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports.map(r => ({ seed: r.seed, finished: r.finished, elapsedMs: r.elapsedMs,
  obstacles: r.obstacles, crests: r.crestCrossings, shifts: r.shifts, jumps: r.jumps,
  collected: r.collected, rockRecoveries: r.rockRecoveries, rivalHitReactions: r.rivalHitReactions,
  ghostSamples: r.ghostSamples, replay: !!r.replay })), null, 2));
assert.ok(reports.some(r => r.finished), 'At least one full-course seed must finish');
console.log(`${reports.filter(r => r.finished).length}/${reports.length} full-course seeds finished; each successful seed replayed with three matching natural ghost splits.`);
