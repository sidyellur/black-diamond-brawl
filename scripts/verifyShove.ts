/**
 * The directional SHOVE (code name: PUSH). Headless model checks through the
 * real Player / AIRider / CollisionSystem / CombatSystem / ScoreTracker.
 *
 * Naming: the older `SHOVE_*` constants belong to the jab's exchange. Every
 * constant, method and event for the new second attack is `PUSH_*` / `push*`;
 * "SHOVE" is only the player-facing word.
 */
import assert from 'node:assert/strict';
import {
  ATTACK_COOLDOWN_MS, ATTACK_SWING_MS, KNOCKOUT_WINDOW_MS, LANES, MAX_SPEED, POINTS, PUSH_COOLDOWN_MS,
  PUSH_HAZARD_LOOKAHEAD_MS, PUSH_SPEED_LOSS, PUSH_SWING_MS, SEGMENT_LENGTH, SHOVE_IMMUNITY_MS, STAGGER_PIPS,
  TREE_CLAMP_SEGMENTS, WEAPON_CHARGES
} from '../src/config';
import { AIRider, AIRiderParams } from '../src/entities/aiRider';
import { BoostMeter } from '../src/entities/boost';
import { CollisionSystem } from '../src/entities/collision';
import { CombatSystem } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';
import { ScoreTracker } from '../src/entities/scoring';

const STEP = 1000 / 60;
let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
const rider = (over: Partial<AIRiderParams> = {}) => new AIRider({
  cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: 1, startZOffset: 0, paletteIndex: 0, ...over
});
const obstacle = (kind: Obstacle['kind'], lane: number, z: number): Obstacle => ({ kind, lane, z, segIndex: Math.floor(z / SEGMENT_LENGTH) });
const tree = (lane: number, z: number) => obstacle('tree', lane, z);
const Z = 10_000;

function world(o: { playerLane?: number; riderLane?: number; obstacles?: Obstacle[]; armed?: boolean; riderSpeed?: number; playerSpeed?: number; reaction?: number } = {}) {
  const obstacles = o.obstacles ?? [];
  const player = new Player();
  if ((o.playerLane ?? 2) !== 2) player.applyKnockback(o.playerLane!, 0);
  for (let i = 0; i < 20; i++) player.update(16);
  player.worldZ = Z; player.speed = o.playerSpeed ?? MAX_SPEED;
  if (o.armed) player.armWeapon();
  const r = rider({ startLane: o.riderLane ?? 1, reactionDistanceSegments: o.reaction ?? 8 });
  r.worldZ = Z; r.speed = o.riderSpeed ?? MAX_SPEED * 0.9;
  const combat = new CombatSystem(player, [r], obstacles);
  // Contact edges fire body checks; the shove is what a player does after
  // settling beside or in a rival's lane, so start already "in contact".
  (combat as unknown as { inContact: Set<AIRider> }).inContact.add(r);
  return { player, r, combat, obstacles };
}
type World = ReturnType<typeof world>;

/** One tick so the target is picked (the real frame order), then the press. */
function push(w: World, held: -1 | 0 | 1 = 0, now = 1000): boolean {
  w.combat.update(16, now);
  return w.combat.attemptPush(now, held);
}
/** Where the rival ends up after a push, with nothing else in the world moving. */
function settledLane(w: World): number {
  for (let i = 0; i < 20; i++) w.r.update(16, w.obstacles, w.player);
  return w.r.laneIndex;
}
function lanePushed(o: Parameters<typeof world>[0], held: -1 | 0 | 1 = 0): number {
  const w = world(o);
  assert.equal(push(w, held), true, 'the push lands');
  return settledLane(w);
}

/** Full simulation after a push: rider update, its own collisions, combat. */
function run(w: World, ms: number, startMs = 1000): { time: number } {
  const collisions = new CollisionSystem();
  let time = startMs;
  for (let t = 0; t < ms; t += STEP) {
    time += STEP;
    w.player.update(STEP);
    w.r.update(STEP, w.obstacles, w.player);
    collisions.update(w.r, w.obstacles);
    w.combat.update(STEP, time);
  }
  return { time };
}

console.log('\n=== directional shove ===');

test('config: starting numbers and naming', () => {
  assert.equal(PUSH_SWING_MS, 400);
  assert.equal(PUSH_COOLDOWN_MS, 900);
  assert.equal(PUSH_SPEED_LOSS, 0.2);
  assert.equal(POINTS.PUSH, 100);
  assert.ok(PUSH_SWING_MS > ATTACK_SWING_MS && PUSH_COOLDOWN_MS > ATTACK_COOLDOWN_MS, 'the shove costs more than the jab');
  assert.equal(STAGGER_PIPS.HIT, 1);
});

test('direction: an adjacent rival is pushed directly away from the player', () => {
  assert.equal(lanePushed({ playerLane: 2, riderLane: 3 }), 4);
  assert.equal(lanePushed({ playerLane: 2, riderLane: 1 }), 0);
  assert.equal(lanePushed({ playerLane: 3, riderLane: 2 }), 1);
  assert.equal(lanePushed({ playerLane: 1, riderLane: 2 }), 3);
  // The held steer key does not override a rival that is clearly to one side.
  assert.equal(lanePushed({ playerLane: 2, riderLane: 3 }, -1), 4);
});

test('direction: same lane goes to the side being held', () => {
  assert.equal(lanePushed({ playerLane: 2, riderLane: 2 }, -1), 1);
  assert.equal(lanePushed({ playerLane: 2, riderLane: 2 }, 1), 3);
  assert.equal(lanePushed({ playerLane: 1, riderLane: 1 }, 1), 2, 'held right overrides toward-centre');
  assert.equal(lanePushed({ playerLane: 3, riderLane: 3 }, -1), 2, 'held left overrides toward-centre');
});

test('direction: same lane with nothing held goes toward road centre', () => {
  assert.equal(lanePushed({ playerLane: 1, riderLane: 1 }), 2);
  assert.equal(lanePushed({ playerLane: 0, riderLane: 0 }), 1);
  assert.equal(lanePushed({ playerLane: 3, riderLane: 3 }), 2);
  assert.equal(lanePushed({ playerLane: 4, riderLane: 4 }), 3);
  assert.equal(lanePushed({ playerLane: 2, riderLane: 2 }), 3, 'dead centre ties to the right, as knockbacks do');
});

test('direction: at the road edge the push flips inward', () => {
  assert.equal(lanePushed({ playerLane: 1, riderLane: 0 }), 1, 'away would be off the road: flips');
  assert.equal(lanePushed({ playerLane: 3, riderLane: 4 }), 3);
  assert.equal(lanePushed({ playerLane: 0, riderLane: 0 }, -1), 1, 'held outward at the wall flips');
  assert.equal(lanePushed({ playerLane: 4, riderLane: 4 }, 1), 3);
});

test('tree clamp: the player\'s shove ignores it, the jab does not', () => {
  const blocked = [tree(4, Z + SEGMENT_LENGTH * 2)];
  const jab = world({ playerLane: 2, riderLane: 3, obstacles: blocked });
  jab.combat.update(16, 1000);
  assert.equal(jab.combat.attemptAttack(1000), true);
  assert.equal(settledLane(jab), 3, 'the jab refuses to knock a rival into a tree');
  const shove = world({ playerLane: 2, riderLane: 3, obstacles: blocked });
  assert.equal(push(shove), true);
  assert.equal(settledLane(shove), 4, 'the shove goes where the player sends it');
  assert.ok(TREE_CLAMP_SEGMENTS >= 2, 'the tree is inside the clamp window');
});

test('tree clamp: rivals\' attacks on the player are still clamped', () => {
  // A legacy untyped rival that is faster wins a same-lane contact. Its knockback
  // on the player heads toward lane 3, where a tree sits in the clamp window.
  const lane = (obstacles: Obstacle[]) => {
    const player = new Player();
    for (let i = 0; i < 20; i++) player.update(16);
    player.worldZ = Z; player.speed = MAX_SPEED * 0.5;
    const r = rider({ startLane: 2 }); r.worldZ = Z; r.speed = MAX_SPEED;
    const combat = new CombatSystem(player, [r], obstacles);
    combat.update(16, 1000);
    for (let i = 0; i < 20; i++) player.update(16);
    return player.laneIndex;
  };
  assert.equal(lane([]), 3, 'without a tree the player is knocked to lane 3');
  assert.equal(lane([tree(3, Z + SEGMENT_LENGTH * 2)]), 2, 'with a tree in lane 3 the knockback is refused');
});

test('ski pole: the shove goes two lanes and spends a charge', () => {
  const armed = world({ playerLane: 0, riderLane: 1, armed: true });
  assert.equal(armed.player.weaponCharges, WEAPON_CHARGES);
  assert.equal(push(armed), true);
  assert.equal(armed.player.weaponCharges, WEAPON_CHARGES - 1);
  assert.equal(settledLane(armed), 3);
  const plain = world({ playerLane: 0, riderLane: 1 });
  assert.equal(push(plain), true);
  assert.equal(settledLane(plain), 2);
  assert.equal(plain.player.weaponCharges, 0);
  // A wall stops the second lane rather than wrapping.
  assert.equal(lanePushed({ playerLane: 1, riderLane: 2, armed: true }), 4);
  assert.equal(lanePushed({ playerLane: 2, riderLane: 3, armed: true }), 4);
});

test('ski pole: a tree in the middle lane ends the push AT the tree', () => {
  const w = world({ playerLane: 0, riderLane: 1, armed: true, obstacles: [tree(2, Z + SEGMENT_LENGTH * 2)] });
  assert.equal(push(w), true);
  assert.equal(settledLane(w), 2, 'not dragged invisibly through the tree to lane 3');
  assert.equal(w.player.weaponCharges, WEAPON_CHARGES - 1);
});

test('a shove always lands: no speed comparison, no stagger, no counter', () => {
  const w = world({ playerLane: 2, riderLane: 3, playerSpeed: MAX_SPEED * 0.4, riderSpeed: MAX_SPEED });
  const before = w.r.speed;
  assert.equal(push(w), true);
  assert.ok(Math.abs(w.r.speed - before * (1 - PUSH_SPEED_LOSS)) < 1e-6, '20% speed loss');
  assert.equal(w.r.stagger, 0, 'no stagger pip');
  assert.equal(w.r.hitReacting, true);
  assert.deepEqual(w.combat.events.map((e) => e.type), ['push']);
  // The jab in the same spot loses to a faster rival and does not move it.
  const jab = world({ playerLane: 2, riderLane: 3, playerSpeed: MAX_SPEED * 0.4, riderSpeed: MAX_SPEED });
  jab.combat.update(16, 1000);
  jab.combat.attemptAttack(1000);
  assert.equal(jab.r.stagger, 0);
  assert.equal(jab.combat.events.length, 0, 'the faster rival wins the jab exchange');

  // Counter window: HIT is the counter; a shove is refused, and does not spend it.
  const c = world({ playerLane: 2, riderLane: 3 });
  c.combat.update(16, 1000);
  (c.combat as unknown as { counterRider: AIRider; counterRemainingMs: number }).counterRider = c.r;
  (c.combat as unknown as { counterRemainingMs: number }).counterRemainingMs = 500;
  assert.equal(c.combat.pushTarget, null);
  assert.equal(c.combat.attemptPush(1000, 0), false);
  assert.equal(c.combat.counterTarget, c.r, 'the counter window is untouched');
  assert.equal(c.combat.attemptAttack(1000), true, 'the jab still counters');
});

test('a refused press is free; an accepted one costs 400 ms of steering and 900 ms of cooldown', () => {
  const none = world({ playerLane: 0, riderLane: 4 });
  assert.equal(push(none), false);
  assert.equal(none.player.swingMsRemaining, 0);
  assert.equal(none.combat.pushOnCooldown, false);

  const w = world({ playerLane: 2, riderLane: 3 });
  assert.equal(push(w), true);
  assert.equal(w.player.swingMsRemaining, PUSH_SWING_MS);
  assert.equal(w.player.swinging, true);
  w.player.requestLaneShift(1);
  assert.equal(w.player.laneIndex, 2, 'steering is locked');
  assert.equal(w.combat.pushOnCooldown, true);
  assert.equal(w.combat.pushCooldownFraction, 1);
  assert.equal(w.combat.attackOnCooldown, false, 'the jab\'s cooldown is separate');
  // The rival is back in reach later; pair immunity (500) has lapsed but the cooldown has not.
  w.r.worldZ = Z; w.player.worldZ = Z;
  w.combat.update(PUSH_COOLDOWN_MS - 100, 1900);
  assert.equal(w.combat.pushOnCooldown, true);
  assert.equal(w.combat.pushTarget, null);
  w.combat.update(100, 2000);
  assert.equal(w.combat.pushOnCooldown, false);
});

test('pair immunity: jab then shove (or shove then jab) on one rival is not an instant combo', () => {
  const a = world({ playerLane: 2, riderLane: 3 });
  a.combat.update(16, 1000);
  assert.equal(a.combat.attemptAttack(1000), true);
  assert.equal(a.combat.attemptPush(1000, 0), false, 'immune right after a jab');
  a.r.worldZ = Z; a.player.worldZ = Z;
  a.combat.update(SHOVE_IMMUNITY_MS + 1, 1600);
  assert.equal(a.combat.attemptPush(1600, 0), true, 'allowed once the pair immunity has lapsed');

  const b = world({ playerLane: 2, riderLane: 3 });
  assert.equal(push(b), true);
  assert.equal(b.combat.attemptAttack(1000), false, 'immune right after a shove');
});

test('knockout credit: a shoved rival that hits a tree is credited, once', () => {
  setDeterministicRuntime(3);
  const w = world({ playerLane: 2, riderLane: 3, obstacles: [tree(4, Z + SEGMENT_LENGTH * 3)] });
  assert.equal(push(w), true);
  w.combat.events.length = 0;
  run(w, 1500);
  assert.equal(w.r.treeStrikes, 1, 'the rival hit the tree');
  assert.equal(w.combat.events.filter((e) => e.type === 'knockout').length, 1);
  assert.ok(KNOCKOUT_WINDOW_MS >= 1500);
  // Scoring: 100 for the shove, 500 for the knockout.
  const w2 = world({ playerLane: 2, riderLane: 3, obstacles: [tree(4, Z + SEGMENT_LENGTH * 3)] });
  const scorer = new ScoreTracker(w2.player, [w2.r], w2.obstacles, new CollisionSystem(), w2.combat);
  assert.equal(push(w2), true);
  scorer.update(STEP);
  assert.equal(scorer.feedback.find((e) => e.kind === 'push')?.points, POINTS.PUSH);
  const collisions = new CollisionSystem();
  for (let t = 0; t < 1500; t += STEP) {
    w2.player.update(STEP); w2.r.update(STEP, w2.obstacles, w2.player); collisions.update(w2.r, w2.obstacles);
    w2.combat.update(STEP, 1000 + t); scorer.update(STEP);
  }
  const result = scorer.finalize(false, 5000, 1);
  assert.equal(result.pushCount, 1);
  assert.equal(result.pushPoints, POINTS.PUSH);
  assert.equal(result.knockoutCount, 1);
  assert.equal(result.knockoutPoints, POINTS.KNOCKOUT);
  assert.equal(result.combatHitCount, 0, 'a shove is not a jab');
  assert.equal(BoostMeter.gainFor(['push'], false) > 0, true, 'a shove feeds the boost meter');
});

test('learnability: a shove within 3 segments of a tree connects even against a rival that would dodge', () => {
  // Full-reaction rival (12 segments of lookahead, the most alert there is).
  for (const segments of [1, 2, 3]) {
    setDeterministicRuntime(5);
    const w = world({ playerLane: 2, riderLane: 3, reaction: 12, obstacles: [tree(4, Z + SEGMENT_LENGTH * segments)] });
    assert.equal(push(w), true);
    run(w, 1500);
    assert.equal(w.r.treeStrikes, 1, `tree ${segments} segment(s) ahead of the pushed rival is hit`);
  }
  // Hit reaction freezes the rival's own steering, so no extra lock is needed.
  const w = world({ playerLane: 2, riderLane: 3, reaction: 12 });
  push(w);
  assert.equal(w.r.hitReacting, true);
});

test('timing: from a long way off the rival has time to dodge back out', () => {
  setDeterministicRuntime(5);
  const w = world({ playerLane: 2, riderLane: 3, reaction: 12, obstacles: [tree(4, Z + SEGMENT_LENGTH * 11)] });
  assert.equal(push(w), true);
  run(w, 2500);
  assert.equal(w.r.treeStrikes, 0, 'an early shove can be dodged: the move has a timing skill');
});

test('cue and outcome agree: the plan names the lane the push uses and the hazard it will meet', () => {
  const cases: Array<[Parameters<typeof world>[0], -1 | 0 | 1]> = [
    [{ playerLane: 2, riderLane: 3 }, 0], [{ playerLane: 2, riderLane: 2 }, -1], [{ playerLane: 1, riderLane: 0 }, 0],
    [{ playerLane: 0, riderLane: 1, armed: true }, 0], [{ playerLane: 2, riderLane: 2 }, 0]
  ];
  for (const [opts, held] of cases) {
    for (const hazard of [null, tree(4, Z + 400), obstacle('rock', 2, Z + 300)]) {
      const o = { ...opts, obstacles: hazard ? [hazard] : [] };
      const w = world(o);
      w.combat.update(16, 1000);
      const target = w.combat.pushTarget!;
      const plan = w.combat.pushPlan(target, held);
      assert.equal(w.combat.attemptPush(1000, held), true);
      assert.equal(settledLane(w), plan.lane, 'the plan\'s lane is where the rival ends up');
      const expected = hazard && hazard.lane === plan.lane ? hazard.kind : null;
      assert.equal(plan.hazard, expected);
    }
  }
  // Reach: an obstacle farther than ~1 s of travel is not a cue; a rock counts as well as a tree.
  const reach = MAX_SPEED * 0.9 * PUSH_HAZARD_LOOKAHEAD_MS / 1000;
  const far = world({ playerLane: 2, riderLane: 3, obstacles: [tree(4, Z + reach + SEGMENT_LENGTH)] });
  far.combat.update(16, 1000);
  assert.equal(far.combat.pushPlan(far.combat.pushTarget!, 0).hazard, null);
  const near = world({ playerLane: 2, riderLane: 3, obstacles: [obstacle('rock', 4, Z + reach - SEGMENT_LENGTH)] });
  near.combat.update(16, 1000);
  assert.equal(near.combat.pushPlan(near.combat.pushTarget!, 0).hazard, 'rock');
  const mogul = world({ playerLane: 2, riderLane: 3, obstacles: [obstacle('mogul', 4, Z + 300)] });
  mogul.combat.update(16, 1000);
  assert.equal(mogul.combat.pushPlan(mogul.combat.pushTarget!, 0).hazard, null, 'a mogul is not a hazard');
});

test('determinism: identical setups produce identical outcomes', () => {
  const once = (): string => {
    setDeterministicRuntime(99);
    const out: string[] = [];
    for (const held of [-1, 0, 1] as const) {
      const w = world({ playerLane: 2, riderLane: 2, obstacles: [tree(3, Z + 600), tree(1, Z + 900)] });
      push(w, held);
      run(w, 1500);
      out.push(`${w.r.laneIndex}:${w.r.treeStrikes}:${Math.round(w.r.worldZ)}:${w.combat.events.map((e) => e.type).join(',')}`);
    }
    return out.join('|');
  };
  assert.equal(once(), once());
});

console.log(`\n${passed} directional shove checks passed`);
