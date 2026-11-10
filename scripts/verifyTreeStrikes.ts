/**
 * Two-strike trees: the first tree is a heavy crash, the second ends the run
 * (player) or eliminates the rival. Headless model checks through the real
 * Player / AIRider / CollisionSystem / CombatSystem / ScoreTracker.
 */
import assert from 'node:assert/strict';
import {
  COLLISION_Z_WINDOW, LANE_TWEEN_MS, LANES, MAX_SPEED, PLAYER_ACCEL, SEGMENT_LENGTH, TREE_CRASH_IMMUNITY_MS,
  TREE_CRASH_TUMBLE_MS, TREE_STRIKES_TO_WIPEOUT, WEAPON_CHARGES, KNOCKOUT_WINDOW_MS, JUMP_AIRTIME_MS
} from '../src/config';
import { AIRider, AIRiderParams } from '../src/entities/aiRider';
import { BoostMeter } from '../src/entities/boost';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { computePlayerPosition, ScoreTracker } from '../src/entities/scoring';
import { rankCupRacers, type RacerSnapshot } from '../src/progression/cup';
import { generateTrack } from '../src/track/generator';

const STEP = 1000 / 60;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const rider = (over: Partial<AIRiderParams> = {}) => new AIRider({
  cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 1, startZOffset: 0, paletteIndex: 0, ...over
});
const tree = (lane: number, z: number): Obstacle => ({ kind: 'tree', lane, z, segIndex: Math.floor(z / SEGMENT_LENGTH) });
const steps = (ms: number) => Math.round(ms / STEP);

console.log('\n=== two-strike trees ===');

test('config: two strikes, 1.5s tumble, 1.5s immunity', () => {
  assert.equal(TREE_STRIKES_TO_WIPEOUT, 2);
  assert.equal(TREE_CRASH_TUMBLE_MS, 1500);
  assert.equal(TREE_CRASH_IMMUNITY_MS, 1500);
});

test('player: first tree is a heavy crash, second wipes out', () => {
  const p = new Player(); p.speed = MAX_SPEED;
  p.crashIntoTree();
  assert.equal(p.wipedOut, false);
  assert.equal(p.treeStrikes, 1);
  assert.equal(p.speed, 0);
  assert.equal(p.heavyCrashing, true);
  assert.equal(p.tumbling, true);
  p.crashIntoTree();
  assert.equal(p.wipedOut, true);
  assert.equal(p.treeStrikes, 2);
  assert.equal(p.treeCrashSerial, 2);
});

test('player: stopped dead for the whole tumble, no steering or jumping, then accelerates away', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.worldZ = 5000; p.crashIntoTree();
  const z0 = p.worldZ;
  for (let i = 0; i < steps(TREE_CRASH_TUMBLE_MS) - 1; i++) {
    p.update(STEP);
    p.requestLaneShift(1); p.jump(false);
    assert.equal(p.speed, 0); assert.equal(p.worldZ, z0); assert.equal(p.airborne, false);
    assert.equal(p.laneIndex, 2); assert.equal(p.heavyCrashing, true);
  }
  p.update(STEP); p.update(STEP); // cross the 1.5s mark
  assert.equal(p.heavyCrashing, false);
  assert.equal(p.tumbling, false);
  assert.ok(p.speed > 0 && p.speed < PLAYER_ACCEL * 0.1, `accelerating from rest: ${p.speed}`);
});

test('player: collisionImmune for the full tumble plus the full immunity window, then not', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.crashIntoTree();
  let t = 0;
  while (p.collisionImmune && t < 10_000) { p.update(STEP); t += STEP; }
  near(t, TREE_CRASH_TUMBLE_MS + TREE_CRASH_IMMUNITY_MS, STEP * 2);
  assert.equal(p.wipedOut, false);
});
function near(a: number, b: number, tol: number): void { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

test('player: heavy crash clears ski-pole charges, steering buffer and the lane tween', () => {
  const p = new Player(); p.armWeapon(); assert.equal(p.weaponCharges, WEAPON_CHARGES);
  p.requestLaneShift(1);
  p.crashIntoTree();
  assert.equal(p.weaponCharges, 0);
  const lane = p.laneIndex;
  for (let i = 0; i < 20; i++) p.update(STEP);
  assert.equal(p.laneIndex, lane, 'no stale steer fires during or after the tumble');
});

test('player: an airborne tree hit follows the same two-strike rule and cancels the jump', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.worldZ = 1000;
  const first = tree(2, 1000); const second = tree(2, 1000 + SEGMENT_LENGTH * 40);
  const cs = new CollisionSystem();
  p.jump(false); assert.equal(p.airborne, true);
  cs.update(p, [first, second]);
  assert.equal(p.airborne, false); assert.equal(p.treeStrikes, 1); assert.equal(p.wipedOut, false);
  for (let i = 0; i < steps(TREE_CRASH_TUMBLE_MS + TREE_CRASH_IMMUNITY_MS) + 2; i++) p.update(STEP);
  assert.equal(p.collisionImmune, false);
  p.worldZ = second.z; p.speed = MAX_SPEED; p.jump(true); assert.equal(p.airborne, true);
  cs.update(p, [first, second]);
  assert.equal(p.wipedOut, true); assert.equal(p.airborne, false);
});

test('player: immune rider passes through a tree without consuming it or striking', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.crashIntoTree();
  const cs = new CollisionSystem(); const t = tree(2, p.worldZ);
  cs.update(p, [t]);
  assert.equal(p.treeStrikes, 1); assert.equal(cs.wasHit(t), false);
});

test('player: rocks and moguls cannot interrupt the heavy crash', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.crashIntoTree();
  const cs = new CollisionSystem();
  cs.update(p, [{ kind: 'rock', lane: 2, z: p.worldZ, segIndex: 0 }, { kind: 'mogul', lane: 2, z: p.worldZ, segIndex: 0 }]);
  assert.equal(p.speed, 0); assert.equal(p.stumbling, false);
});

test('rival: first tree is a heavy crash (held at 0, immune), second eliminates', () => {
  const r = rider(); const player = new Player(); r.worldZ = 5000; r.speed = MAX_SPEED;
  r.crashIntoTree();
  assert.equal(r.wipedOut, false); assert.equal(r.treeStrikes, 1);
  assert.equal(r.speed, 0); assert.equal(r.tumbling, true); assert.equal(r.heavyCrashing, true);
  const z0 = r.worldZ;
  for (let i = 0; i < steps(TREE_CRASH_TUMBLE_MS) - 1; i++) {
    r.update(STEP, [], player);
    assert.equal(r.speed, 0); assert.equal(r.worldZ, z0); assert.equal(r.collisionImmune, true);
  }
  r.update(STEP, [], player); r.update(STEP, [], player);
  assert.equal(r.heavyCrashing, false); assert.ok(r.speed > 0 && r.collisionImmune, 'accelerating, still immune');
  let t = TREE_CRASH_TUMBLE_MS;
  while (r.collisionImmune && t < 10_000) { r.update(STEP, [], player); t += STEP; }
  near(t, TREE_CRASH_TUMBLE_MS + TREE_CRASH_IMMUNITY_MS, STEP * 3);
  r.crashIntoTree();
  assert.equal(r.wipedOut, true); assert.equal(r.treeStrikes, 2); assert.equal(r.speed, 0);
});

test('rival: a heavy crash preserves the setback (no catch-up boost for 4s)', () => {
  const player = new Player(); player.worldZ = 500_000; player.speed = MAX_SPEED;
  const r = rider(); r.worldZ = 0; r.speed = MAX_SPEED; r.crashIntoTree();
  let peak = 0, t = 0;
  for (; t < 3900; t += STEP) { r.update(STEP, [], player); peak = Math.max(peak, r.speed); }
  assert.ok(peak <= MAX_SPEED + 1e-6, `grace window: ${peak}`);
  for (; t < 9000; t += STEP) { r.update(STEP, [], player); peak = Math.max(peak, r.speed); }
  assert.ok(peak > MAX_SPEED, 'catch-up resumes after the grace window');
});

test('combat: a rival that takes its FIRST tree soon after a shove is credited a knockout', () => {
  setDeterministicRuntime(7);
  const player = new Player(); player.worldZ = 10_000; player.speed = MAX_SPEED;
  const r = rider({ startLane: 3 }); r.worldZ = 10_000; r.speed = MAX_SPEED * 0.5;
  const combat = new CombatSystem(player, [r], []);
  combat.update(16, 1000);
  assert.equal(combat.attemptAttack(1000), true, 'shove lands');
  combat.events.length = 0;
  r.crashIntoTree();
  assert.equal(r.wipedOut, false);
  combat.update(16, 1500);
  assert.equal(combat.events.filter(e => e.type === 'knockout').length, 1);
  combat.events.length = 0;
  combat.update(16, 1516);
  assert.equal(combat.events.filter(e => e.type === 'knockout').length, 0, 'credited once per crash');
  // And the crashed rival is immune: nobody can be hit while down.
  assert.equal(r.collisionImmune, true);
  player.worldZ = r.worldZ;
  combat.update(16, 4000);
  assert.equal(combat.attemptAttack(4000), false, 'cannot attack a rival that is down');
});

test('combat: a first tree with no recent shove is not a knockout; the elimination after a shove is', () => {
  setDeterministicRuntime(7);
  const player = new Player(); player.worldZ = 10_000; player.speed = MAX_SPEED;
  const r = rider({ startLane: 3 }); r.worldZ = 10_000; r.speed = MAX_SPEED * 0.5;
  const combat = new CombatSystem(player, [r], []);
  combat.update(16, 60_000);
  r.crashIntoTree(); combat.update(16, 60_016);
  assert.equal(combat.events.length, 0);
  r.markShovedByPlayer(70_000); r.crashIntoTree(); // second strike inside the window
  combat.update(16, 70_000 + KNOCKOUT_WINDOW_MS - 1);
  assert.equal(r.wipedOut, true);
  assert.equal(combat.events.filter(e => e.type === 'knockout').length, 1);
});

test('combat: a heavy-crashing player cannot be struck or knocked back', () => {
  setDeterministicRuntime(7);
  const player = new Player(); player.worldZ = 10_000; player.speed = MAX_SPEED;
  const r = rider({ startLane: 2 }); r.worldZ = 10_000; r.speed = MAX_SPEED;
  const combat = new CombatSystem(player, [r], []);
  player.crashIntoTree();
  assert.equal(player.collisionImmune, true);
  const lane = player.laneIndex;
  combat.update(16, 1000); combat.update(16, 1100);
  assert.equal(player.hitReacting, false);
  assert.equal(player.laneIndex, lane);
  assert.equal(player.speed, 0);
});

test('scoring: a heavy crash breaks Flow like a rock and keeps earned score', () => {
  const p = new Player(); p.worldZ = 1200; p.speed = MAX_SPEED;
  const rv = rider(); const combat = new CombatSystem(p, [rv], []);
  const score = new ScoreTracker(p, [rv], [], new CollisionSystem(), combat);
  for (let i = 0; i < 6; i++) { combat.events.push({ type: 'hit', rider: rv }); score.update(0); }
  assert.ok(score.chain >= 6);
  const earned = score.runningScore;
  p.crashIntoTree(); score.update(0);
  assert.equal(score.chain, 0); assert.equal(score.runningScore, earned);
  // a hit scored during the crash does not rebuild the chain
  combat.events.push({ type: 'hit', rider: rv }); score.update(0);
  assert.equal(score.chain, 0);
});

test('boost: a heavy crash empties the meter (rocks keep half); one crash empties it once', () => {
  const m = new BoostMeter(); m.add(100);
  const calm = { wipedOut: false, heavyCrashing: false, tumbling: false, stumbling: false, hitReacting: false, airborne: false };
  m.observe(calm);
  m.observe({ ...calm, heavyCrashing: true, tumbling: true });
  assert.equal(m.value, 0); assert.equal(m.active, false);
  m.add(40); m.observe({ ...calm, heavyCrashing: true, tumbling: true });
  assert.equal(m.value, 40, 'not re-emptied every frame of the same crash');
});

test('position: a rider who heavy-crashed once and finished is a finisher in position and Cup rank', () => {
  const p = new Player(); p.worldZ = 99_000; p.crashIntoTree();
  const rivals = [0, 1, 2, 3].map(i => { const r = rider({ paletteIndex: i }); r.worldZ = 98_000 - i * 1000; return r; });
  rivals[0].finishTimeMs = 80_000; rivals[1].finishTimeMs = 95_000;
  assert.equal(computePlayerPosition(p, rivals, 90_000), 2);
  assert.equal(computePlayerPosition(p, rivals, null), 3, 'still racing and ahead of the unfinished rivals');
  const snap = (id: RacerSnapshot['id'], t: number | null, out: boolean): RacerSnapshot => ({ id, worldZ: 1e5, finishTimeMs: t, wipedOut: out });
  const ranked = rankCupRacers([snap('player', 90_000, false), snap('rival-0', 80_000, false), snap('rival-1', 95_000, false), snap('rival-2', null, true), snap('rival-3', null, true)]);
  const you = ranked.find(r => r.id === 'player')!;
  assert.equal(you.position, 2); assert.ok(you.points > 0);
});

test('immunity distance: a rider can steer for the whole second half, and no crash site can force the second strike', () => {
  // Timing: steering unlocks at the end of the tumble; immunity ends later.
  const p0 = new Player(); p0.speed = MAX_SPEED; p0.crashIntoTree(); const z0 = p0.worldZ;
  let steerAt = -1, immuneEnd = -1, z = 0;
  for (let i = 0; i < 400; i++) {
    p0.update(STEP);
    if (steerAt < 0 && p0.canJump) steerAt = i * STEP;
    if (immuneEnd < 0 && !p0.collisionImmune) { immuneEnd = i * STEP; z = p0.worldZ - z0; break; }
  }
  assert.ok(steerAt >= 0 && immuneEnd - steerAt >= 2 * LANE_TWEEN_MS, `steer ${steerAt}ms, immunity ends ${immuneEnd}ms`);
  const travelled = 0.5 * PLAYER_ACCEL * (TREE_CRASH_IMMUNITY_MS / 1000) ** 2;
  near(z, travelled, 100);

  // Every sampled tree on many generated courses: crash there, then steer
  // (from the first steerable moment only) to a lane with no tree at the
  // spot where immunity ends. Strike two must never happen, and a clear lane
  // must always exist within two lane shifts.
  const treeNear = (obstacles: Obstacle[], zc: number, lane: number) =>
    obstacles.some(o => o.kind === 'tree' && o.lane === lane && Math.abs(o.z - zc) <= COLLISION_Z_WINDOW * 2);
  let sites = 0, needed = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { obstacles } = generateTrack(seed);
    // A chute's wall trees stand every second segment, so "a lane clear at the exact spot immunity ends" is no test
    // of them: a rider who stays in a wall lane meets the next tree a moment later. They are checked with the right
    // rule (steer INWARD at the first steerable moment) in scripts/verifyChute.ts, for every wall and both sides.
    for (const t of obstacles.filter(o => o.kind === 'tree' && !o.wall).filter((_, i) => i % 3 === 0)) {
      const p = new Player();
      p.applyKnockback(t.lane, 0);
      for (let i = 0; i < 12; i++) p.update(STEP);
      assert.equal(p.laneIndex, t.lane);
      p.worldZ = t.z - 5; p.speed = MAX_SPEED;
      const cs = new CollisionSystem();
      cs.update(p, [t]);
      if (p.treeStrikes !== 1) continue;
      sites++;
      const probe = new Player(); probe.worldZ = p.worldZ; probe.crashIntoTree();
      while (probe.collisionImmune) probe.update(STEP);
      const zEnd = probe.worldZ;
      let target = p.laneIndex;
      if (treeNear(obstacles, zEnd, target)) {
        needed++;
        const options = [target - 1, target + 1, target - 2, target + 2]
          .filter(l => l >= 0 && l < LANES.length && !treeNear(obstacles, zEnd, l));
        assert.ok(options.length > 0, `seed ${seed}: no clear lane at the immunity boundary`);
        target = options[0];
      }
      const others = obstacles.filter(o => o !== t);
      for (let i = 0; i < 400; i++) {
        p.update(STEP);
        if (p.canJump && p.laneIndex !== target) p.requestLaneShift(target > p.laneIndex ? 1 : -1);
        cs.update(p, others);
        if (p.worldZ > zEnd + COLLISION_Z_WINDOW * 3) break;
      }
      assert.equal(p.wipedOut, false, `seed ${seed}: second strike at the immunity boundary despite steering from the first steerable moment`);
    }
  }
  assert.ok(sites > 100, `exercised ${sites} crash sites`);
  console.log(`    (${sites} crash sites on 60 courses; ${needed} needed a lane change at the immunity boundary; steering unlocks at ${steerAt.toFixed(0)}ms, immunity ends at ${immuneEnd.toFixed(0)}ms, ~${z.toFixed(0)} units after the tumble)`);
});

test('immunity distance: a tree placed exactly where immunity ends is a real threat, and avoidable from the first steerable moment', () => {
  const crashOne = () => { const p = new Player(); p.speed = MAX_SPEED; p.crashIntoTree(); return p; };
  const probe = crashOne(); const z0 = probe.worldZ;
  while (probe.collisionImmune) probe.update(STEP);
  const wall = tree(2, probe.worldZ + 1);
  const run = (steer: boolean) => {
    const p = crashOne(); const cs = new CollisionSystem(); let steered = false;
    for (let i = 0; i < 400; i++) {
      p.update(STEP);
      if (steer && !steered && p.canJump) { p.requestLaneShift(1); steered = true; }
      cs.update(p, [wall]);
    }
    return p;
  };
  assert.equal(run(false).wipedOut, true, 'staying put takes strike two (the boundary is real)');
  assert.equal(run(true).wipedOut, false, 'one steer at the first steerable moment avoids it');
  assert.ok(wall.z - z0 > SEGMENT_LENGTH * 8, 'the row is 8+ segments from the crash');
});

console.log(`\n${passed} tree strike checks passed`);
