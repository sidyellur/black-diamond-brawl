/**
 * Pickups (#36): shield, speed wax and snowball beside the ski pole.
 * Course-level: count per course, kind mix, lane fairness (every pickup is
 * collectable without crossing a tree), determinism, and that obstacles and
 * rivals are untouched by pickup placement. Rules-level, through the real
 * Player / CombatSystem / CollisionSystem / ScoreTracker / BoostMeter: each
 * effect, weapon-slot replacement, shield vs exchange / rock / tree, the
 * snowball target rule and range, melee-wins-over-throw, scoring.
 * Run: node --import tsx scripts/verifyPickups.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BOOST_MAX, JUMP_REACH_EXTENDED, LANE_CHANGE_SEGMENTS, LANES, MAX_SPEED,
  PICKUP_KIND_WEIGHTS, POINTS, ROCK_SPEED_FACTOR, SEGMENT_LENGTH, SNOWBALL_RANGE_SEGMENTS, WAX_BOOST_GAIN,
  WEAPON_CHARGES
} from '../src/config';
import { AIRider, type AIRiderParams } from '../src/entities/aiRider';
import { BoostMeter } from '../src/entities/boost';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import { segmentCentreZ, type Obstacle } from '../src/entities/obstacle';
import { collectPickups, PICKUP_KIND_LIST, type Pickup, type PickupKind } from '../src/entities/pickup';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';
import { COURSE_VERSION } from '../src/progression/rules';
import { generateTrack } from '../src/track/generator';
import { pickupStream, placePickups } from '../src/track/pickupPlacement';
import { gapLaneChangeSegments } from '../src/track/surface';
import { chuteEnd } from '../src/track/chute';

const STEP = 1000 / 60;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }

// --- course level -----------------------------------------------------------
const SEEDS = 1000;
const courses = Array.from({ length: SEEDS }, (_, i) => generateTrack(i + 1));
// [obstacles, aiRiders] hashes recorded on `mountain-v2`, before the pickup rework. The obstacle hash is of every
// obstacle OUTSIDE the tree chute (#39, part 3), which replaces 3-6 of them per course: the rival hashes are the
// original v2 values; the obstacle hashes were re-recorded from `main`'s own obstacle lists with the chute's funnel
// and walled stretch cut out (and the powder entry moguls left out, as before), so they still prove that nothing else moved.
const PINNED_V2: Record<number, [string, string]> = {
  7919: ['93133d08db66', '1a74cadd4fda'], 15838: ['38c56e61018f', '6f2412957e2c'],
  23757: ['da0ce85dd911', '5cde15b8cf42'], 2375700: ['9ecbbc24a59c', '44c99764c656']
};
console.log('\n=== pickups: course generation ===');

test('count per course is 5-9, and the course version moved', () => {
  const counts = courses.map((c) => c.pickups.length);
  const min = Math.min(...counts); const max = Math.max(...counts);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`    pickups per course over ${SEEDS} seeds: min ${min}, max ${max}, mean ${mean.toFixed(2)}`);
  assert.ok(min >= 5 && max <= 9, `count range ${min}..${max}`);
  assert.equal(COURSE_VERSION, 'mountain-v3');
});

test('kind distribution roughly matches the weights', () => {
  const tally: Record<PickupKind, number> = { pole: 0, shield: 0, wax: 0, snowball: 0 };
  let total = 0;
  for (const c of courses) for (const p of c.pickups) { tally[p.kind]++; total++; }
  const weightSum = PICKUP_KIND_LIST.reduce((n, k) => n + PICKUP_KIND_WEIGHTS[k], 0);
  const report = PICKUP_KIND_LIST.map((k) => {
    const share = tally[k] / total; const want = PICKUP_KIND_WEIGHTS[k] / weightSum;
    assert.ok(Math.abs(share - want) < 0.03, `${k}: ${(share * 100).toFixed(1)}% vs ${(want * 100).toFixed(1)}%`);
    return `${k} ${(share * 100).toFixed(1)}% (want ${(want * 100).toFixed(0)}%)`;
  });
  console.log(`    ${total} pickups: ${report.join(', ')}`);
  // Every course should carry more than one kind; one-kind courses would make the pickups pointless.
  assert.ok(courses.every((c) => new Set(c.pickups.map((p) => p.kind)).size >= 2));
});

/** Independent reachability: tree-only blocking (rocks/moguls are crossable), crest steering locks honoured, and
 *  the lane-change cost of the shared helper, so a pickup on or after ice is judged at the ice cost (#39). */
function treeFreeReachable(course: ReturnType<typeof generateTrack>): (seg: number) => Set<number> {
  const locked = new Set<number>();
  for (const apex of course.crestApexes) for (let s = apex; s <= apex + JUMP_REACH_EXTENDED; s++) locked.add(s);
  const treeRows = new Map<number, Set<number>>();
  for (const o of course.obstacles) if (o.kind === 'tree') {
    if (!treeRows.has(o.segIndex)) treeRows.set(o.segIndex, new Set());
    treeRows.get(o.segIndex)!.add(o.lane);
  }
  const rowSegs = [...treeRows.keys()].sort((a, b) => a - b);
  const shift = (set: Set<number>, from: number, to: number): Set<number> => {
    let steerable = 0;
    for (let s = from + 1; s <= to; s++) if (!locked.has(s)) steerable++;
    const reach = Math.floor(steerable / gapLaneChangeSegments(course.segments, from, to));
    const out = new Set<number>();
    for (const l of set) for (let d = -reach; d <= reach; d++) if (l + d >= 0 && l + d < LANES.length) out.add(l + d);
    return out;
  };
  return (target: number) => {
    let reachable = new Set<number>(LANES.map((_, i) => i));
    let at = 0;
    for (const row of rowSegs) {
      if (row >= target) break;
      reachable = new Set([...shift(reachable, at, row)].filter((l) => !treeRows.get(row)!.has(l)));
      at = row;
    }
    return shift(reachable, at, target);
  };
}

test('every pickup is collectable without crossing a tree, and sits on a clear lane', () => {
  let checked = 0;
  for (const [i, course] of courses.entries()) {
    const reachable = treeFreeReachable(course);
    for (const p of course.pickups) {
      checked++;
      assert.ok(reachable(p.segIndex).has(p.lane), `seed ${i + 1}: pickup at seg ${p.segIndex} lane ${p.lane} needs a tree to reach`);
      const blocked = course.obstacles.filter((o) => o.segIndex === p.segIndex).map((o) => o.lane);
      assert.ok(!blocked.includes(p.lane), `seed ${i + 1}: pickup shares a cell with an obstacle`);
      assert.equal(p.z, segmentCentreZ(p.segIndex));
      assert.ok(p.lane >= 0 && p.lane < LANES.length && !p.collected);
    }
  }
  console.log(`    ${checked} pickups checked`);
});

test('pickups on or after ice are reachable at the ice lane-change cost, and the ice cost is what changed them', () => {
  // Reachability above already uses the shared helper. Here: how many pickups sit where the cost is the ice one,
  // and how many courses a pickup lane differs from the ordinary-cost placement (placement is the same code with
  // the surfaces cleared, so it shows exactly what the ice cost altered).
  let onIceGap = 0; let courseDiffs = 0;
  for (const [i, course] of courses.entries()) {
    const plain = placePickups({ obstacles: course.obstacles, crestApexes: course.crestApexes,
      placeableStart: 100, placeableEnd: course.segments.findIndex((s) => s.safeZone === 'runout') }, pickupStream(i + 1));
    const rows = [...new Set(course.obstacles.map((o) => o.segIndex))].sort((a, b) => a - b);
    for (const p of course.pickups) {
      const before = rows.filter((r) => r < p.segIndex).at(-1) ?? 100;
      if (gapLaneChangeSegments(course.segments, before, p.segIndex) !== LANE_CHANGE_SEGMENTS) onIceGap++;
    }
    if (JSON.stringify(plain.map((p) => [p.segIndex, p.lane, p.kind])) !== JSON.stringify(course.pickups.map((p) => [p.segIndex, p.lane, p.kind]))) courseDiffs++;
  }
  console.log(`    ${onIceGap} pickups sit in a gap that touches ice; ${courseDiffs} of ${SEEDS} courses place a pickup differently than with the ordinary cost`);
  assert.ok(onIceGap > 0, 'the ice cost is exercised by real pickups');
});

test('pickups sit inside the placeable stretch with the configured spacing', () => {
  for (const course of courses.slice(0, 200)) {
    for (let i = 1; i < course.pickups.length; i++) {
      const gap = course.pickups[i].segIndex - course.pickups[i - 1].segIndex;
      assert.ok(gap >= 150 && gap <= 220, `gap ${gap}`);
    }
    assert.ok(course.pickups.every((p) => !course.segments[p.segIndex].isFinish));
  }
});

test('generation is deterministic, and pickup placement never touches obstacles or rivals', () => {
  const again = generateTrack(77);
  assert.deepEqual(again.pickups, generateTrack(77).pickups);
  assert.notDeepEqual(generateTrack(78).pickups, again.pickups);
  // Pinned from `mountain-v2` (before pickups changed): obstacles and rival
  // parameters for these seeds must stay byte-identical across the version bump.
  const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
  const actual: Record<number, [string, string]> = {};
  for (const seed of Object.keys(PINNED_V2).map(Number)) {
    const t = generateTrack(seed);
    // Powder (#39) appends entry moguls after the pinned v2 obstacle field was
    // recorded; every other obstacle must still be byte-identical to it.
    const entry = new Set(t.powder.flatMap((f) => f.moguls.map((lane) => `${f.start}:${lane}`)));
    const chute = t.chute[0];
    const cut = (o: { segIndex: number }) => o.segIndex >= chute.funnelStart && o.segIndex < chuteEnd(chute);
    actual[seed] = [h(t.obstacles.filter((o) => !(o.kind === 'mogul' && entry.has(`${o.segIndex}:${o.lane}`)) && !cut(o))), h(t.aiRiders)];
  }
  assert.deepEqual(actual, PINNED_V2);
});

// --- rules level --------------------------------------------------------------
console.log('\n=== pickups: effects, shield, snowball ===');

const rider = (over: Partial<AIRiderParams> = {}) => new AIRider({
  cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 2, startZOffset: 10_000, paletteIndex: 0, ...over
});
const pickupOf = (kind: PickupKind, player: Player): Pickup =>
  ({ kind, lane: player.laneIndex, segIndex: 0, z: player.worldZ, collected: false });
const collect = (player: Player, kind: PickupKind, boost = new BoostMeter()) =>
  collectPickups(player, [pickupOf(kind, player)], boost);
const rock = (lane: number, z: number): Obstacle => ({ kind: 'rock', lane, segIndex: Math.floor(z / SEGMENT_LENGTH), z });
const tree = (lane: number, z: number): Obstacle => ({ kind: 'tree', lane, segIndex: Math.floor(z / SEGMENT_LENGTH), z });

/** Player at lane 2 with rivals placed `ahead` segments in front, each in its own lane. */
function world(rivals: Array<{ lane: number; ahead: number; speed?: number }>, obstacles: Obstacle[] = [],
  setup?: (player: Player) => void) {
  setDeterministicRuntime(7);
  const player = new Player(); player.speed = MAX_SPEED * 0.6; player.worldZ = 10_000;
  const riders = rivals.map((r, i) => {
    const a = rider({ startLane: r.lane, startZOffset: 10_000 + r.ahead * SEGMENT_LENGTH, paletteIndex: i % 4 });
    a.speed = r.speed ?? MAX_SPEED * 0.5;
    return a;
  });
  const combat = new CombatSystem(player, riders, obstacles);
  const collisions = new CollisionSystem();
  const score = new ScoreTracker(player, riders, obstacles, collisions, combat);
  let now = 1000;
  const tick = (ms = STEP) => { now += ms; combat.update(ms, now); };
  setup?.(player);
  tick(); // pick the melee target (and resolve any contact the setup created)
  /** The scene's attack press: melee first, throw as the fallback. */
  const press = () => (combat.attemptAttack(now) ? 'melee' : combat.attemptThrow(now) ? 'throw' : 'none');
  return { player, riders, combat, collisions, score, tick, press, now: () => now };
}

test('each effect applies the moment it is collected and is reported', () => {
  const p = new Player(); const boost = new BoostMeter();
  assert.deepEqual(collectPickups(p, [pickupOf('pole', p)], boost), ['pole']);
  assert.equal(p.weaponCharges, WEAPON_CHARGES);
  collect(p, 'shield'); assert.equal(p.shielded, true);
  collect(p, 'wax', boost); assert.equal(boost.value, WAX_BOOST_GAIN);
  collect(p, 'wax', boost); assert.equal(boost.value, BOOST_MAX, 'wax clamps at the meter maximum');
  const q = new Player(); collect(q, 'snowball'); assert.equal(q.snowballs, 1);
  assert.equal(q.weaponCharges, 0); assert.equal(q.shielded, false);
});

test('pole and snowball share one slot: each replaces the other; shield and wax do not touch it', () => {
  const p = new Player();
  collect(p, 'pole'); collect(p, 'snowball');
  assert.equal(p.weaponCharges, 0); assert.equal(p.snowballs, 1);
  collect(p, 'pole');
  assert.equal(p.weaponCharges, WEAPON_CHARGES); assert.equal(p.snowballs, 0);
  collect(p, 'shield'); collect(p, 'wax');
  assert.equal(p.weaponCharges, WEAPON_CHARGES, 'shield and wax leave the weapon alone');
  collect(p, 'snowball'); collect(p, 'snowball');
  assert.equal(p.snowballs, 1, 'a second snowball adds nothing');
});

test('a second shield does nothing extra; one break spends it', () => {
  const p = new Player(); collect(p, 'shield'); collect(p, 'shield');
  assert.equal(p.shielded, true);
  assert.equal(p.breakShield(), true); assert.equal(p.shielded, false);
  assert.equal(p.breakShield(), false); assert.equal(p.shieldBreakSerial, 1);
});

test('pickups collect while airborne, but not once wiped out', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.jump(false); assert.equal(p.airborne, true);
  assert.deepEqual(collect(p, 'shield'), ['shield']);
  const dead = new Player(); dead.crashIntoTree(); dead.crashIntoTree();
  assert.deepEqual(collect(dead, 'shield'), []); assert.equal(dead.shielded, false);
});

test('shield absorbs a rock: no speed loss, no tumble, and it is gone', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.worldZ = 5000; p.giveShield();
  const cs = new CollisionSystem(); const r = rock(2, 5000);
  cs.update(p, [r]);
  assert.equal(p.speed, MAX_SPEED); assert.equal(p.tumbling, false); assert.equal(p.collisionImmune, false);
  assert.equal(p.shielded, false); assert.equal(cs.wasHit(r), true, 'the rock is consumed, not re-hit');
  const second = rock(2, 5000 + SEGMENT_LENGTH * 20); p.worldZ = second.z;
  cs.update(p, [second]);
  assert.equal(p.tumbling, true); near(p.speed, MAX_SPEED * ROCK_SPEED_FACTOR);
});

test('shield does NOT absorb a tree: strike counted, heavy crash, and the shield survives the first one', () => {
  const p = new Player(); p.speed = MAX_SPEED; p.worldZ = 5000; p.giveShield();
  const cs = new CollisionSystem();
  cs.update(p, [tree(2, 5000)]);
  assert.equal(p.treeStrikes, 1); assert.equal(p.heavyCrashing, true); assert.equal(p.speed, 0);
  assert.equal(p.shielded, true, 'a tree neither spends nor is stopped by the shield');
  assert.equal(p.shieldBreakSerial, 0);
  // The second tree is run-ending regardless of the shield.
  for (let i = 0; i < 300; i++) p.update(STEP);
  p.worldZ = 9000; p.speed = MAX_SPEED;
  cs.update(p, [tree(2, 9000)]);
  assert.equal(p.wipedOut, true); assert.equal(p.shielded, false, 'a wipeout clears everything held');
});

test('heavy crash: the weapon slot (pole or snowball) is cleared, the shield is kept', () => {
  const a = new Player(); a.armWeapon(); a.giveShield(); a.crashIntoTree();
  assert.equal(a.weaponCharges, 0); assert.equal(a.shielded, true);
  const b = new Player(); b.giveSnowball(); b.giveShield(); b.crashIntoTree();
  assert.equal(b.snowballs, 0); assert.equal(b.shielded, true);
  const c = new Player(); c.giveSnowball(); c.crashIntoTree(); c.crashIntoTree();
  assert.equal(c.snowballs, 0); assert.equal(c.wipedOut, true);
});

/** A faster rival in the player's lane wins the passive exchange on the first tick. */
const lossWorld = (shielded: boolean) => world([{ lane: 2, ahead: 0, speed: MAX_SPEED }], [], (player) => {
  player.speed = MAX_SPEED * 0.4;
  if (shielded) player.giveShield();
});

test('shield absorbs a lost exchange: no knockback, speed loss or recoil; pair immunity still set', () => {
  const bare = lossWorld(false);
  assert.ok(bare.player.speed < MAX_SPEED * 0.4, 'control: an unshielded loss costs speed');
  assert.equal(bare.player.hitReacting, true);

  const w = lossWorld(true); const speed = MAX_SPEED * 0.4; const lane = w.player.laneIndex;
  assert.equal(w.player.speed, speed); assert.equal(w.player.hitReacting, false);
  assert.equal(w.player.laneIndex, lane); assert.equal(w.player.laneOffsetFraction, LANES[lane]);
  assert.equal(w.player.shielded, false); assert.equal(w.player.shieldBreakSerial, 1);
  // Pair immunity: the same rival cannot be attacked or re-trigger straight away.
  w.player.speed = MAX_SPEED; w.riders[0].speed = MAX_SPEED * 0.5;
  assert.equal(w.combat.attemptAttack(w.now()), false);
});

test('shield is not spent when the player WINS an exchange', () => {
  const w = world([{ lane: 2, ahead: 0, speed: MAX_SPEED * 0.3 }], [], (p) => { p.giveShield(); p.speed = MAX_SPEED; });
  assert.equal(w.player.shielded, true);
});

test('snowball target: nearest rival ahead in the same or an adjacent lane within range', () => {
  const w = world([
    { lane: 2, ahead: 9 },   // same lane, far
    { lane: 3, ahead: 5 },   // adjacent lane, nearer  -> the target
    { lane: 4, ahead: 3 },   // two lanes away: never
    { lane: 2, ahead: -4 },  // behind: never
    { lane: 1, ahead: 13 }   // beyond range: never
  ]);
  assert.equal(w.combat.throwTarget, null, 'no target without a snowball');
  w.player.giveSnowball(); w.tick();
  assert.equal(w.combat.target, null);
  assert.equal(w.combat.throwTarget, w.riders[1]);
});

test('snowball range: inside 12 segments yes, beyond no; same lane and both adjacent lanes count', () => {
  const inside = world([{ lane: 2, ahead: SNOWBALL_RANGE_SEGMENTS - 0.5 }]);
  inside.player.giveSnowball(); inside.tick();
  assert.equal(inside.combat.throwTarget, inside.riders[0]);
  const outside = world([{ lane: 2, ahead: SNOWBALL_RANGE_SEGMENTS + 0.5 }]);
  outside.player.giveSnowball(); outside.tick();
  assert.equal(outside.combat.throwTarget, null);
  for (const lane of [1, 3]) {
    const w = world([{ lane, ahead: 6 }]); w.player.giveSnowball(); w.tick();
    assert.equal(w.combat.throwTarget, w.riders[0], `lane ${lane}`);
  }
  const far = world([{ lane: 0, ahead: 6 }]); far.player.giveSnowball(); far.tick();
  assert.equal(far.combat.throwTarget, null, 'two lanes over is out');
});

test('target ties go to the nearer lane; an ineligible rival is skipped for the next one', () => {
  const w = world([{ lane: 3, ahead: 6 }, { lane: 2, ahead: 6 }]);
  w.player.giveSnowball(); w.tick();
  assert.equal(w.combat.throwTarget, w.riders[1]);
  const x = world([{ lane: 2, ahead: 4 }, { lane: 3, ahead: 8 }]);
  x.player.giveSnowball(); x.riders[0].hitReactionMsRemaining = 0;
  (x.riders[0] as unknown as { wipedOut: boolean }).wipedOut = true; x.tick();
  assert.equal(x.combat.throwTarget, x.riders[1]);
});

test('the throw resolves as an ordinary lost exchange: knockback, 1 stagger pip, hit event, cooldown, no pole bonus', () => {
  const w = world([{ lane: 2, ahead: 6 }]);
  w.player.giveSnowball(); w.tick();
  const r = w.riders[0]; const speed = r.speed;
  assert.equal(w.press(), 'throw');
  assert.equal(w.player.snowballs, 0);
  near(r.speed, speed * 0.8); // SHOVE_SPEED_LOSS_FACTOR, not the armed loss
  assert.equal(r.stagger, 1); assert.equal(r.hitReacting, true);
  assert.deepEqual(w.combat.events.map((e) => e.type), ['hit']);
  assert.equal(w.combat.attackOnCooldown, true); assert.equal(w.player.swinging, false, 'a throw does not lock steering');
  assert.equal(w.combat.throwEvents.length, 1);
  assert.equal(w.press(), 'none', 'snowball spent');
  assert.equal(w.combat.attemptThrow(w.now()), false);
});

test('throw knocks the rival exactly one lane, away from the player\'s line', () => {
  const w = world([{ lane: 3, ahead: 6 }]);
  w.player.giveSnowball(); w.tick(); w.press();
  for (let i = 0; i < 30; i++) w.riders[0].update(STEP, [], w.player);
  assert.equal(w.riders[0].laneIndex, 4);
});

test('with a melee target in reach, Attack does the melee hit and the snowball is kept', () => {
  const w = world([{ lane: 3, ahead: 0.4 }, { lane: 2, ahead: 7 }]);
  w.player.giveSnowball(); w.tick();
  assert.equal(w.combat.target, w.riders[0]);
  assert.equal(w.combat.throwTarget, null, 'no throw marker while a melee target exists');
  assert.equal(w.press(), 'melee');
  assert.equal(w.player.snowballs, 1); assert.equal(w.player.swinging, true);
  assert.equal(w.riders[1].stagger, 0, 'the far rival was not touched');
});

test('no throw while on cooldown, airborne or tumbling; the marker hides with it', () => {
  const w = world([{ lane: 2, ahead: 6 }]);
  w.player.giveSnowball(); w.tick();
  assert.notEqual(w.combat.throwTarget, null);
  w.player.jump(false); w.tick();
  assert.equal(w.combat.throwTarget, null); assert.equal(w.press(), 'none');
  const t = world([{ lane: 2, ahead: 6 }]); t.player.giveSnowball(); t.player.hitRock(); t.tick();
  assert.equal(t.combat.throwTarget, null);
  assert.equal(t.player.snowballs, 1, 'a refused press keeps the snowball');
});

test('a throw scores as a deliberate hit (250), counts as a combat hit for the locker challenge, and feeds boost', () => {
  const w = world([{ lane: 2, ahead: 6 }]);
  w.player.giveSnowball(); w.tick(); w.press(); w.score.update(STEP);
  assert.deepEqual(w.score.feedback.map((f) => [f.kind, f.points]), [['hit', POINTS.COMBAT_HIT]]);
  assert.equal(w.score.finalize(true, 90_000, 1).combatHitCount, 1);
  assert.ok(BoostMeter.gainFor(w.score.feedback.map((f) => f.kind), false) > 0);
});

test('throw is deterministic: the same setup gives identical rival state and events', () => {
  const run = () => {
    const w = world([{ lane: 3, ahead: 5 }, { lane: 2, ahead: 9 }]);
    w.player.giveSnowball(); w.tick(); w.press();
    for (let i = 0; i < 40; i++) { w.riders.forEach((r) => r.update(STEP, [], w.player)); w.tick(); }
    return JSON.stringify([w.riders.map((r) => [r.laneIndex, r.speed, r.stagger]), w.combat.events.map((e) => e.type)]);
  };
  assert.equal(run(), run());
});

test('pole pushes are unchanged by a snowball: an armed shove still goes two lanes', () => {
  const armed = world([{ lane: 2, ahead: 0.3 }]); armed.player.armWeapon(); armed.tick();
  assert.equal(armed.combat.pushPlan(armed.riders[0]).shift, 2);
  const ball = world([{ lane: 2, ahead: 0.3 }]); ball.player.giveSnowball(); ball.tick();
  assert.equal(ball.combat.pushPlan(ball.riders[0]).shift, 1);
});

function near(a: number, b: number, tol = 1): void { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

console.log(`\n=== ${passed} pickup checks passed ===`);
