/**
 * The single touch STRIKE button. Headless model checks through the real Player /
 * AIRider / CombatSystem: the decision ladder, that the label and the press can
 * never disagree, and that it only ever calls the existing attempt* methods.
 */
import assert from 'node:assert/strict';
import { MAX_SPEED, SEGMENT_LENGTH } from '../src/config';
import { AIRider } from '../src/entities/aiRider';
import { CombatSystem, chooseStrike, STRIKE_LABELS, type StrikeKind, type StrikeState } from '../src/entities/combat';
import type { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';

let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`  PASS ${name}`); }
setDeterministicRuntime?.(1);

const Z = 10_000;
const obstacle = (kind: Obstacle['kind'], lane: number, z: number): Obstacle => ({ kind, lane, z, segIndex: Math.floor(z / SEGMENT_LENGTH) });

interface Setup {
  playerLane?: number; riderLane?: number; dz?: number; obstacles?: Obstacle[];
  snowball?: boolean; counter?: boolean; attackCooldown?: boolean; riderSpeed?: number;
}
function world(o: Setup = {}) {
  const obstacles = o.obstacles ?? [];
  const player = new Player();
  if ((o.playerLane ?? 2) !== 2) player.applyKnockback(o.playerLane!, 0);
  for (let i = 0; i < 20; i++) player.update(16);
  player.worldZ = Z; player.speed = MAX_SPEED;
  if (o.snowball) player.giveSnowball();
  const r = new AIRider({ cruiseSpeedFactor: 1, aggression: 0, reactionDistanceSegments: 8, startLane: o.riderLane ?? 3, startZOffset: 0, paletteIndex: 0 });
  r.worldZ = Z + (o.dz ?? 40); r.speed = o.riderSpeed ?? MAX_SPEED * 0.9;
  const combat = new CombatSystem(player, [r], obstacles);
  const hidden = combat as unknown as { inContact: Set<AIRider>; counterRider: AIRider | null; counterRemainingMs: number; attackCooldownMs: number };
  hidden.inContact.add(r);
  combat.update(16, 1000); // pick the target the way the frame loop does
  if (o.counter) { hidden.counterRider = r; hidden.counterRemainingMs = 500; }
  if (o.attackCooldown) hidden.attackCooldownMs = 300;
  return { player, r, combat, obstacles };
}
type World = ReturnType<typeof world>;

/** Observable result of a press, so it can be compared with what was promised. */
function outcome(w: World) {
  return {
    hits: w.combat.events.filter((e) => e.type === 'hit').length,
    pushes: w.combat.events.filter((e) => e.type === 'push').length,
    counters: w.combat.skillEvents.filter((e) => e.type === 'counter').length,
    throws: w.combat.throwEvents.length,
    attackCd: w.combat.attackOnCooldown,
    pushCd: w.combat.pushOnCooldown,
    snowballs: w.player.snowballs
  };
}

console.log('\n=== single touch strike button ===');

test('chooseStrike: priority ladder over every combination of the five facts', () => {
  for (let bits = 0; bits < 32; bits++) {
    const s: StrikeState = { counterReady: !!(bits & 1), shoveAvailable: !!(bits & 2), shoveHazard: !!(bits & 4), attackAvailable: !!(bits & 8), throwAvailable: !!(bits & 16) };
    // Written out independently of the implementation.
    let want: StrikeKind = 'none';
    if (s.counterReady) want = 'attack';
    else if (s.shoveAvailable && s.shoveHazard) want = 'shove';
    else if (s.attackAvailable) want = 'attack';
    else if (s.throwAvailable) want = 'throw';
    assert.equal(chooseStrike(s), want, JSON.stringify(s));
  }
  // Spot checks of the named rules.
  const base: StrikeState = { counterReady: false, shoveAvailable: false, shoveHazard: false, attackAvailable: false, throwAvailable: false };
  assert.equal(chooseStrike({ ...base, counterReady: true, shoveAvailable: true, shoveHazard: true, attackAvailable: true }), 'attack', 'a counter beats a hazard shove');
  assert.equal(chooseStrike({ ...base, shoveAvailable: true, shoveHazard: true, attackAvailable: true }), 'shove', 'the "!" moment beats a plain hit');
  assert.equal(chooseStrike({ ...base, shoveAvailable: true, attackAvailable: true }), 'attack');
  assert.equal(chooseStrike({ ...base, throwAvailable: true }), 'throw');
  assert.equal(chooseStrike({ ...base, shoveAvailable: true }), 'none', 'rule 5: a hazard-free shove is never fired for the player');
});

test('labels: HIT normally, SHOVE with a "!" for a shove, THROW for a throw; shove is distinguishable without colour', () => {
  assert.equal(STRIKE_LABELS.attack, 'HIT');
  assert.equal(STRIKE_LABELS.none, 'HIT');
  assert.equal(STRIKE_LABELS.throw, 'THROW');
  assert.match(STRIKE_LABELS.shove, /^SHOVE/);
  assert.ok(STRIKE_LABELS.shove.includes('!'));
  assert.equal(new Set(Object.values(STRIKE_LABELS)).size, 3, 'three distinct words');
});

test('counter window: reads HIT and performs the counter, even with a hazard beside the rival', () => {
  const w = world({ counter: true, obstacles: [obstacle('rock', 4, Z + 300)] });
  assert.equal(w.combat.counterReady, true);
  assert.equal(w.combat.strikeIntent(0), 'attack');
  assert.equal(w.combat.attemptStrike(1000, 0), true);
  const o = outcome(w);
  assert.equal(o.counters, 1, 'the counter fired');
  assert.equal(o.pushes, 0);
});

test('hazard: with a rock in the lane the rival would be pushed to, the button shoves', () => {
  const w = world({ playerLane: 2, riderLane: 3, obstacles: [obstacle('rock', 4, Z + 300)] });
  assert.equal(w.combat.pushPlan(w.combat.pushTarget!, 0).hazard, 'rock');
  assert.equal(w.combat.strikeIntent(0), 'shove');
  assert.equal(w.combat.attemptStrike(1000, 0), true);
  const o = outcome(w);
  assert.deepEqual([o.pushes, o.hits, o.pushCd, o.attackCd], [1, 0, true, false], 'a shove, not a hit; the jab stays available');
  const tree = world({ playerLane: 2, riderLane: 1, obstacles: [obstacle('tree', 0, Z + 300)] });
  assert.equal(tree.combat.strikeIntent(0), 'shove', 'a tree counts too');
});

test('hazard cue follows the held steer direction, and the press uses the same direction', () => {
  // Rival in the player\'s own lane: it goes to the side being held.
  const mk = () => world({ playerLane: 2, riderLane: 2, dz: 40, obstacles: [obstacle('rock', 3, Z + 300)] });
  const w = mk();
  assert.equal(w.combat.strikeIntent(1), 'shove', 'holding right sends it into the rock');
  assert.equal(w.combat.strikeIntent(-1), 'attack', 'holding left does not: a plain hit');
  assert.equal(w.combat.strikeIntent(0), 'shove', 'nothing held at dead centre ties to the right, the same as the arrow shows');
  const pressed = mk();
  assert.equal(pressed.combat.attemptStrike(1000, 1), true);
  assert.equal(outcome(pressed).pushes, 1);
  const other = mk();
  assert.equal(other.combat.attemptStrike(1000, -1), true);
  assert.equal(outcome(other).hits, 1);
  assert.equal(outcome(other).pushes, 0);
});

test('no hazard: the button is an ordinary hit', () => {
  const w = world({ playerLane: 2, riderLane: 3 });
  assert.equal(w.combat.strikeIntent(0), 'attack');
  assert.equal(w.combat.attemptStrike(1000, 0), true);
  const o = outcome(w);
  assert.deepEqual([o.hits, o.pushes, o.attackCd, o.pushCd], [1, 0, true, false]);
});

test('snowball: reads THROW and throws when no melee target exists', () => {
  const w = world({ snowball: true, riderLane: 3, dz: SEGMENT_LENGTH * 4 });
  assert.equal(w.combat.target, null, 'out of melee reach');
  assert.equal(w.combat.strikeIntent(0), 'throw');
  assert.equal(w.combat.attemptStrike(1000, 0), true);
  const o = outcome(w);
  assert.deepEqual([o.throws, o.snowballs, o.hits, o.pushes], [1, 0, 1, 0]);
  const melee = world({ snowball: true, riderLane: 3 });
  assert.equal(melee.combat.strikeIntent(0), 'attack', 'a melee target keeps the snowball');
  assert.equal(melee.combat.attemptStrike(1000, 0), true);
  assert.equal(outcome(melee).snowballs, 1);
});

test('rule 5 decision: a hazard-free shove is NOT fired while the hit recharges; G / L still can', () => {
  const w = world({ playerLane: 2, riderLane: 3, attackCooldown: true });
  assert.notEqual(w.combat.pushTarget, null, 'a shove would land');
  assert.equal(w.combat.pushPlan(w.combat.pushTarget!, 0).hazard, null);
  assert.equal(w.combat.target, null, 'the hit is recharging');
  assert.equal(w.combat.strikeIntent(0), 'none');
  assert.equal(STRIKE_LABELS[w.combat.strikeIntent(0)], 'HIT');
  const before = outcome(w);
  assert.equal(w.combat.attemptStrike(1000, 0), false, 'the press is refused');
  assert.deepEqual(outcome(w), before, 'nothing spent: no event, no cooldown, no steering lock');
  assert.equal(w.player.swingMsRemaining, 0);
  // The keyboard path is untouched.
  assert.equal(w.combat.attemptPush(1000, 0), true, 'G / L shoves regardless');
});

test('nothing in reach: the press is refused and costs nothing', () => {
  const w = world({ dz: SEGMENT_LENGTH * 40 });
  assert.equal(w.combat.strikeIntent(0), 'none');
  const before = outcome(w);
  assert.equal(w.combat.attemptStrike(1000, 0), false);
  assert.deepEqual(outcome(w), before);
});

test('label and press always agree: sweep of staged situations', () => {
  const kinds: Array<Obstacle['kind'] | null> = [null, 'rock', 'tree'];
  const seen = new Set<StrikeKind>();
  let cases = 0;
  for (const playerLane of [0, 1, 2, 3, 4]) for (const riderLane of [0, 1, 2, 3, 4]) {
    if (Math.abs(playerLane - riderLane) > 1) continue;
    for (const obstacleLane of [0, 1, 2, 3, 4]) for (const kind of kinds) {
      for (const dz of [40, SEGMENT_LENGTH * 4, SEGMENT_LENGTH * 40]) for (const snowball of [false, true]) {
        for (const counter of [false, true]) for (const attackCooldown of [false, true]) for (const held of [-1, 0, 1] as const) {
          if (kind === null && obstacleLane !== 0) continue;
          const obstacles = kind ? [obstacle(kind, obstacleLane, Z + 300)] : [];
          const w = world({ playerLane, riderLane, dz, obstacles, snowball, counter, attackCooldown });
          const intent = w.combat.strikeIntent(held);
          const label = STRIKE_LABELS[intent];
          seen.add(intent);
          const before = outcome(w);
          const started = w.combat.attemptStrike(1000, held);
          const after = outcome(w);
          const ctx = JSON.stringify({ playerLane, riderLane, obstacleLane, kind, dz, snowball, counter, attackCooldown, held, intent });
          if (intent === 'shove') {
            assert.equal(label, STRIKE_LABELS.shove); assert.ok(started, ctx);
            assert.equal(after.pushes, before.pushes + 1, ctx); assert.equal(after.hits, before.hits, ctx);
          } else if (intent === 'throw') {
            assert.equal(label, 'THROW'); assert.ok(started, ctx);
            assert.equal(after.throws, before.throws + 1, ctx); assert.equal(after.pushes, before.pushes, ctx);
          } else if (intent === 'attack') {
            assert.equal(label, 'HIT'); assert.ok(started, ctx);
            assert.equal(after.pushes, before.pushes, ctx); assert.equal(after.throws, before.throws, ctx);
            assert.equal(after.attackCd, true, ctx);
          } else {
            assert.equal(label, 'HIT'); assert.equal(started, false, ctx);
            assert.deepEqual(after, before, ctx);
          }
          cases++;
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['attack', 'none', 'shove', 'throw'], 'the sweep reached every outcome');
  assert.ok(cases > 1000, `swept ${cases} situations`);
});

test('a SHOVE label is only ever shown when a hazard waits (the "!" cue) and no counter is open', () => {
  for (const held of [-1, 0, 1] as const) for (const lane of [0, 1, 2, 3, 4]) {
    const w = world({ playerLane: 2, riderLane: 3, obstacles: [obstacle('rock', lane, Z + 300)] });
    if (w.combat.strikeIntent(held) === 'shove') {
      const plan = w.combat.pushPlan(w.combat.pushTarget!, held);
      assert.notEqual(plan.hazard, null);
      assert.equal(w.combat.counterReady, false);
    }
  }
});

console.log(`\n=== ${passed} strike checks passed ===\n`);
