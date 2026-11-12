/**
 * Feel pass model checks: slow motion, combat cues and the proof that none of
 * it changes a race.
 *
 *  1. SlowMotion obeys its budget: waits for the simulation hit-stop, never
 *     chains, never starts under reduced motion.
 *  2. Taps made during slow motion are executed exactly once (not dropped,
 *     not doubled).
 *  3. Combat cues map each kind of blow to its own sound and weight.
 *  4. A scripted race (real entities, a player that fights and dodges) ends in
 *     byte-identical state with effects off, effects on with slow motion and
 *     ragged frame times, and reduced motion.
 */
import assert from 'node:assert/strict';
import { FEEL, SEGMENT_LENGTH } from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import { PlayerInputController } from '../src/entities/input';
import { Player } from '../src/entities/player';
import { collectPickups } from '../src/entities/pickup';
import { BoostMeter } from '../src/entities/boost';
import { ScoreTracker } from '../src/entities/scoring';
import { CUP_SEEDS, cupRivalParams } from '../src/progression/cup';
import { CheckpointTracker, GhostRecorder, checkpointWorldZs } from '../src/progression/ghost';
import { FixedRaceClock } from '../src/progression/clock';
import { FIXED_STEP_MS } from '../src/progression/rules';
import { generateTrack } from '../src/track/generator';
import { surfaceAtZ } from '../src/track/surface';
import { chuteAhead } from '../src/track/chute';
import { classifyCombat, CUE_LEVEL, CUE_SOUND, CUE_WEIGHT } from '../src/render/feelCues';
import { SlowMotion } from '../src/render/slowMotion';
import { flowLevelFor } from '../src/audio/music';
import { SOUNDS } from '../src/audio/effects';
import { seededRandom } from '../src/audio/voice';
// @ts-expect-error JavaScript acceptance helper is outside production tsconfig.
import { naturalRaceDriver } from './naturalRaceDriver.mjs';

// ---- 1. SlowMotion budget -------------------------------------------------
{
  const slow = new SlowMotion();
  assert.equal(slow.advance(16, false), 1, 'idle is full speed');
  assert.equal(slow.request(), true);
  // Waits for the freeze: no slow motion while the simulation is frozen.
  for (let i = 0; i < 6; i++) assert.equal(slow.advance(16, true), 1, 'pending beat waits out the hit-stop');
  const frames: number[] = [];
  for (let t = 0; t < 700; t += 16) frames.push(slow.advance(16, false));
  assert.equal(frames[0], FEEL.SLOWMO_SCALE, 'the beat starts at the floor');
  assert.ok(frames.every(f => f >= FEEL.SLOWMO_SCALE - 1e-9 && f <= 1), 'scale stays between the floor and 1');
  const slowFrames = frames.filter(f => f < 1).length;
  assert.ok(slowFrames * 16 <= FEEL.SLOWMO_MS + 16 && slowFrames * 16 >= FEEL.SLOWMO_MS - 32, `beat lasts about ${FEEL.SLOWMO_MS} ms (${slowFrames * 16})`);
  const easing = frames.slice(frames.findIndex(f => f > FEEL.SLOWMO_SCALE + 1e-6), slowFrames);
  assert.ok(easing.every((f, i) => i === 0 || f >= easing[i - 1] - 1e-9), 'eases back monotonically');
  assert.equal(slow.started, 1);

  // Back-to-back knockouts must not chain.
  const chain = new SlowMotion();
  let slowMs = 0;
  const window: number[] = [];
  let maxWindow = 0;
  for (let t = 0; t < 20000; t += 8) {
    if (t % 200 === 0) chain.request(); // a knockout every 200 ms, relentlessly
    const f = chain.advance(8, false);
    window.push(f < 1 ? 8 : 0);
    slowMs += f < 1 ? 8 : 0;
    if (window.length > 125) window.shift();
    maxWindow = Math.max(maxWindow, window.reduce((a, b) => a + b, 0));
  }
  assert.ok(maxWindow <= FEEL.SLOWMO_MS + 8, `at most ${FEEL.SLOWMO_MS} ms of slow motion in any second (saw ${maxWindow})`);
  assert.ok(chain.started >= 10 && chain.started <= 20000 / FEEL.SLOWMO_COOLDOWN_MS + 1, `beats are spaced by the cooldown (${chain.started})`);
  assert.ok(slowMs / 20000 < FEEL.SLOWMO_MS / FEEL.SLOWMO_COOLDOWN_MS + 0.01, 'slow share of play stays under the budget');

  const reduced = new SlowMotion(true);
  assert.equal(reduced.request(), false);
  for (let i = 0; i < 50; i++) assert.equal(reduced.advance(16, false), 1, 'reduced motion never slows');
}

// ---- 2. Taps during slow motion are neither dropped nor doubled ------------
{
  const rand = seededRandom(5);
  let clockNow = 0;
  let jumps = 0;
  const player = new Player();
  const input = new PlayerInputController(player, () => { jumps++; }, () => clockNow);
  const clock = new FixedRaceClock();
  const slow = new SlowMotion();
  let attacks = 0, pushes = 0, taps = 0;
  const frame = 1000 / 60;
  let nextTap = 40;
  let slowTaps = 0;
  for (let n = 0; n < 6000; n++) {
    clockNow += frame;
    if (n % 90 === 0) slow.request();
    const scale = slow.advance(frame, false);
    if (n >= nextTap) {
      const which = taps % 3;
      const action = which === 0 ? 'jump' : which === 1 ? 'attack' : 'push';
      input.setAction(action, true, `tap${taps}`);
      input.setAction(action, false, `tap${taps}`);
      taps++; if (scale < 1) slowTaps++;
      nextTap = n + 25 + Math.floor(rand() * 40);
    }
    clock.advance(frame * scale, step => {
      input.update(step, frame);
      if (input.attackJustPressed()) attacks++;
      if (input.pushJustPressed()) pushes++;
    });
  }
  // Flush any tap pending at the very end.
  for (let i = 0; i < 10; i++) { clockNow += frame; clock.advance(frame, step => { input.update(step, frame); if (input.attackJustPressed()) attacks++; if (input.pushJustPressed()) pushes++; }); }
  assert.ok(slowTaps > 20, `enough taps landed inside slow motion (${slowTaps})`);
  assert.equal(jumps + attacks + pushes, taps, `every tap executes exactly once (jumps ${jumps}, attacks ${attacks}, shoves ${pushes}, taps ${taps})`);
}

// ---- 3. Combat cues ---------------------------------------------------------
{
  const rider = (knockedDown = false) => ({ knockedDown });
  const a = rider(), b = rider(true), c = rider();
  const ctx = (over: Partial<{ counter: boolean; armed: boolean; thrown: Array<{ knockedDown: boolean }> }> = {}) => ({ counter: false, armed: false, thrown: [], ...over });
  assert.equal(classifyCombat([{ type: 'hit', rider: a }], ctx())[0].kind, 'hit');
  assert.equal(classifyCombat([{ type: 'hit', rider: a }], ctx({ armed: true }))[0].kind, 'pole');
  assert.equal(classifyCombat([{ type: 'hit', rider: a }], ctx({ counter: true, armed: true }))[0].kind, 'counter');
  assert.equal(classifyCombat([{ type: 'hit', rider: a }], ctx({ thrown: [a] }))[0].kind, 'snowball');
  assert.equal(classifyCombat([{ type: 'push', rider: a }], ctx())[0].kind, 'push');
  assert.equal(classifyCombat([{ type: 'brush', rider: a }], ctx())[0].kind, 'brush');
  const ko = classifyCombat([{ type: 'hit', rider: b }, { type: 'knockout', rider: b }], ctx({ armed: true }));
  assert.deepEqual(ko.map(x => x.kind), ['knockdown'], 'a knockdown outranks the hit that caused it, one cue per rider');
  assert.equal(classifyCombat([{ type: 'knockout', rider: c }], ctx())[0].kind, 'treeKnockout', 'a rider put into a tree');
  const kinds = Object.keys(CUE_SOUND) as Array<keyof typeof CUE_SOUND>;
  const sounds = kinds.filter(k => k !== 'brush').map(k => CUE_SOUND[k]);
  assert.equal(new Set(sounds).size, sounds.length, 'every cue kind has its own sound');
  assert.ok(kinds.every(k => SOUNDS[CUE_SOUND[k]] && CUE_WEIGHT[k] > 0 && CUE_LEVEL[k] > 0));
  assert.ok(CUE_WEIGHT.hit < CUE_WEIGHT.pole && CUE_WEIGHT.pole < CUE_WEIGHT.counter && CUE_WEIGHT.counter <= CUE_WEIGHT.knockdown, 'camera response scales with weight');
  assert.deepEqual([0, 2, 3, 5, 6, 9, 10, 40].map(flowLevelFor), [0, 0, 1, 1, 2, 2, 3, 3], 'flow chain -> music layer');
}

// ---- 4. Determinism: effects change nothing ---------------------------------
type Mode = 'plain' | 'effects' | 'reduced';
function makeModel(seed: number, mode: Mode, stats: { requests: number; cues: Record<string, number> }, slow: SlowMotion) {
  const generated = generateTrack(seed);
  const player = new Player();
  const aiRiders = generated.aiRiders.map((params, i) => new AIRider(cupRivalParams(i, params)));
  const collisions = new CollisionSystem();
  const aiCollisions = aiRiders.map(() => new CollisionSystem());
  const combat = new CombatSystem(player, aiRiders, generated.obstacles);
  const scoreTracker = new ScoreTracker(player, aiRiders, generated.obstacles, collisions, combat);
  const finishSegment = generated.segments.find(segment => segment.isFinish)!;
  const ghostRecorder = new GhostRecorder(seed, finishSegment.z);
  const pose = () => ({ worldZ: player.worldZ, laneOffset: player.laneOffsetFraction, jumpHeight: player.jumpArcHeight, lean: player.leanDirection });
  ghostRecorder.capture(0, pose());
  const boost = new BoostMeter();
  let prevWiped = false, prevTumbling = false, prevCrashes = 0, prevCharges = 0, step = 0;
  const breakdown: unknown[] = [];
  return {
    seed, options: { runId: `feel-${mode}-${seed}` }, countdownMs: 0, practiceObjective: null,
    player, aiRiders, aiCollisions, collisions, combat, scoreTracker,
    obstacles: generated.obstacles, pickups: generated.pickups,
    crestApexZs: generated.crestApexes.map(index => index * SEGMENT_LENGTH + SEGMENT_LENGTH / 2),
    finishSegment, ghostRecorder, ghost: null, ghostSplit: '',
    checkpoints: new CheckpointTracker(checkpointWorldZs(player.worldZ, finishSegment.z)),
    elapsedRaceMs: 0, simulationHitStopMs: 0, raceOver: false, breakdown,
    simulate(delta: number, _inputFrameElapsedMs: number) {
      this.elapsedRaceMs += delta;
      const time = this.elapsedRaceMs;
      if (this.simulationHitStopMs > 0) { this.simulationHitStopMs = Math.max(0, this.simulationHitStopMs - delta); return; }
      // A player who picks fights: a jab or a shove whenever one is on offer.
      step++;
      if (step % 12 === 0) { if (!combat.attemptAttack(time)) combat.attemptThrow(time); }
      else if (step % 12 === 6) combat.attemptPush(time, step % 24 === 6 ? 1 : -1);
      const previousZ = player.worldZ;
      player.update(delta, boost.active, surfaceAtZ(generated.segments, player.worldZ));
      if (this.crestApexZs.some(z => previousZ < z && player.worldZ >= z)) player.jump(true, false);
      collisions.update(player, this.obstacles);
      aiRiders.forEach((rider, i) => {
        rider.update(delta, this.obstacles, player, surfaceAtZ(generated.segments, rider.worldZ), chuteAhead(generated.segments, rider.worldZ));
        if (rider.finishTimeMs === null && rider.worldZ >= finishSegment.z) rider.finishTimeMs = time;
        if (rider.finishTimeMs !== null) rider.worldZ = finishSegment.z;
        aiCollisions[i].update(rider, this.obstacles);
      });
      combat.update(delta, time);
      const counter = combat.skillEvents.some(e => e.type === 'counter');
      combat.skillEvents.length = 0;
      const armedHit = player.weaponCharges < prevCharges;
      collectPickups(player, this.pickups, boost);
      prevCharges = player.weaponCharges;
      const thrown = combat.throwEvents.splice(0);
      if (mode !== 'plain') {
        // The routing the scene does: read-only on everything above.
        for (const cue of classifyCombat(combat.events, { counter, armed: armedHit, thrown: thrown.map(t => t.rider) })) {
          stats.cues[cue.kind] = (stats.cues[cue.kind] ?? 0) + 1;
          if (cue.kind === 'knockdown' || cue.kind === 'treeKnockout') { stats.requests++; slow.request(); }
        }
      }
      if (combat.events.length) this.simulationHitStopMs = Math.max(this.simulationHitStopMs, 50);
      if (player.wipedOut && !prevWiped) this.simulationHitStopMs = 133.33333333333334;
      else if (player.heavyCrashing && player.treeCrashSerial > prevCrashes) { this.simulationHitStopMs = 100; if (mode !== 'plain') { stats.requests++; slow.request(); } }
      else if (player.tumbling && !prevTumbling) this.simulationHitStopMs = 83.33333333333334;
      prevWiped = player.wipedOut; prevTumbling = player.tumbling; prevCrashes = player.treeCrashSerial;
      scoreTracker.update(delta);
      ghostRecorder.capture(time, pose());
      this.checkpoints.update(previousZ, player.worldZ, time - delta, time, undefined);
      if ((player.wipedOut && this.simulationHitStopMs <= 0) || player.worldZ >= finishSegment.z) {
        this.raceOver = true;
        const finished = player.worldZ >= finishSegment.z;
        breakdown.push(scoreTracker.finalize(finished, this.elapsedRaceMs, 1));
      }
    }
  };
}

function race(seed: number, mode: Mode) {
  const stats = { requests: 0, cues: {} as Record<string, number> };
  const slow = new SlowMotion(mode === 'reduced');
  const model = makeModel(seed, mode, stats, slow);
  const clock = new FixedRaceClock();
  const rand = seededRandom(seed * 31 + 1);
  let realMs = 0, slowRealMs = 0, frames = 0;
  const recent: number[] = [];
  let maxSlowPerSecond = 0;
  while (!model.raceOver && frames < 200000) {
    // plain: an even 60 Hz. The others: ragged 8-48 ms frames, as a phone gives.
    const frame = mode === 'plain' ? FIXED_STEP_MS : 8 + rand() * 40;
    const scale = mode === 'plain' ? 1 : slow.advance(frame, model.simulationHitStopMs > 0);
    realMs += frame; frames++;
    if (scale < 1) slowRealMs += frame;
    recent.push(scale < 1 ? frame : 0);
    let windowMs = 0, sum = 0;
    for (let i = recent.length - 1; i >= 0; i--) { windowMs += recent[i] === 0 ? 16 : recent[i]; sum += recent[i]; if (windowMs > 1000) break; }
    maxSlowPerSecond = Math.max(maxSlowPerSecond, sum);
    if (recent.length > 120) recent.shift();
    clock.advance(Math.min(50, frame) * scale, () => {
      naturalRaceDriver({ scene: model, maxSteps: 1, render: false });
      return !model.raceOver;
    });
  }
  assert.ok(model.raceOver, `seed ${seed} ${mode}: the race ended`);
  const state = JSON.stringify({
    elapsed: model.elapsedRaceMs, z: model.player.worldZ, speed: model.player.speed, lane: model.player.laneOffsetFraction,
    strikes: model.player.treeStrikes, wiped: model.player.wipedOut, charges: model.player.weaponCharges,
    rivals: model.aiRiders.map(r => [r.worldZ, r.speed, r.laneIndex, r.wipedOut, r.knockedDown, r.finishTimeMs, r.treeCrashSerial]),
    score: model.scoreTracker.runningScore, chain: model.scoreTracker.chain, breakdown: model.breakdown,
    ghostSamples: model.ghostRecorder.sampleCount
  });
  return { state, stats, started: slow.started, realMs, slowRealMs, maxSlowPerSecond };
}

const seeds = [...new Set([202, 3, 77, 101, ...CUP_SEEDS])].slice(0, 7);
let beats = 0, cueTotals: Record<string, number> = {}, longestSlow = 0, stretched = 0;
for (const seed of seeds) {
  const plain = race(seed, 'plain');
  const effects = race(seed, 'effects');
  const reduced = race(seed, 'reduced');
  assert.equal(effects.state, plain.state, `seed ${seed}: effects on (slow motion, ragged frames) match effects off byte for byte`);
  assert.equal(reduced.state, plain.state, `seed ${seed}: reduced motion matches too`);
  assert.equal(reduced.started, 0, 'reduced motion never slows');
  assert.ok(effects.maxSlowPerSecond <= FEEL.SLOWMO_MS + 50, `seed ${seed}: slow motion budget per second (${effects.maxSlowPerSecond.toFixed(0)} ms)`);
  beats += effects.started;
  if (effects.started > 0) stretched += effects.slowRealMs;
  longestSlow = Math.max(longestSlow, effects.maxSlowPerSecond);
  for (const [k, v] of Object.entries(effects.stats.cues)) cueTotals[k] = (cueTotals[k] ?? 0) + v;
}
assert.ok(beats > 0, 'the scripted races exercised slow motion at least once (otherwise this proves nothing)');
console.log(`PASS feel model: ${seeds.length} races x 3 modes identical (state incl. score breakdown, finish time, rivals, ghost samples); ${beats} slow-motion beats, longest slow time in any second ${longestSlow.toFixed(0)} ms; cues seen ${JSON.stringify(cueTotals)}`);
