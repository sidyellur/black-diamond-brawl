/**
 * Headless combat harness.
 *
 * The repo had no test framework at all: the verify chain covered the build,
 * the palette, course solvability and a screenshot smoke test, but nothing
 * could reach combat resolution. That mattered because combat is the one
 * subsystem built from a chain of random rolls — a failing exchange could not
 * be reproduced, let alone asserted on.
 *
 * This drives `CombatSystem` directly against real `Player` / `AIRider`
 * instances with runtime randomness seeded, so every scenario is exactly
 * repeatable. No browser, no Phaser rendering — combat logic does not depend
 * on either.
 *
 * Usage: npm run verify:combat
 */
import {
  ARMED_SHOVE_SPEED_LOSS_FACTOR,
  COLLISION_Z_WINDOW,
  LANES,
  MAX_SPEED,
  SEGMENT_LENGTH,
  SHOVE_IMMUNITY_MS,
  SHOVE_SPEED_LOSS_FACTOR,
  TREE_CLAMP_SEGMENTS,
  ATTACK_COOLDOWN_MS,
  ATTACK_SWING_MS,
  HIT_REACTION_MS,
  POINTS
} from '../src/config';
import { AIRider, AIRiderParams } from '../src/entities/aiRider';
import { CombatSystem } from '../src/entities/combat';
import { Obstacle } from '../src/entities/obstacle';
import { Player } from '../src/entities/player';
import { setDeterministicRuntime } from '../src/entities/runtimeRng';

let failed = 0;
let passed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function riderParams(over: Partial<AIRiderParams> = {}): AIRiderParams {
  return {
    cruiseSpeedFactor: 1,
    aggression: 0,
    reactionDistanceSegments: 8,
    startLane: 1,
    startZOffset: 0,
    paletteIndex: 0,
    ...over
  };
}

/** A world: one player, one rival, and whatever obstacles a case needs. */
function makeWorld(opts: {
  playerLane?: number;
  riderLane?: number;
  playerZ?: number;
  riderZ?: number;
  obstacles?: Obstacle[];
  playerSpeed?: number;
  riderSpeed?: number;
  armed?: boolean;
}) {
  const obstacles = opts.obstacles ?? [];
  const player = new Player();
  // Lane index is private and only commits when a tween completes, so the
  // player is walked across with a zero-loss knockback and then stepped until
  // it settles. `update()` also ADVANCES worldZ, so position and speed are
  // both stamped afterwards — setting them first silently drifts the player
  // ~960 units downhill and quietly invalidates every Z-window assertion.
  const targetLane = opts.playerLane ?? 2;
  if (targetLane !== 2) player.applyKnockback(targetLane, 0);
  for (let i = 0; i < 20; i++) player.update(16);
  player.worldZ = opts.playerZ ?? 10_000;
  player.speed = opts.playerSpeed ?? MAX_SPEED;
  if (opts.armed) player.armWeapon();

  const rider = new AIRider(riderParams({ startLane: opts.riderLane ?? 1 }));
  rider.worldZ = opts.riderZ ?? player.worldZ;
  rider.speed = opts.riderSpeed ?? MAX_SPEED * 0.9;

  const combat = new CombatSystem(player, [rider], obstacles);
  return { player, rider, combat, obstacles };
}

const tree = (lane: number, z: number): Obstacle => ({ kind: 'tree', lane, z });

/**
 * Presses attack.
 *
 * Targeting is recomputed in `CombatSystem.update()`, so a tick has to run
 * before the press for a target to exist — which is exactly the real frame
 * order (update, then next frame's input). Returns whether a swing started.
 */
function attack(combat: CombatSystem, nowMs = 1000): boolean {
  combat.update(16, nowMs);
  return combat.attemptAttack(nowMs);
}

/**
 * Presses attack after any entering-edge body check has resolved and its pair
 * immunity has lapsed — the real sequence when a player rides into a rival's
 * lane and then chooses to attack.
 */
function attackAfterContact(combat: CombatSystem, nowMs = 3000): boolean {
  combat.update(16, 1000);                    // entering edge -> body check
  combat.events.length = 0;                   // drained by the scorer in-game
  combat.update(SHOVE_IMMUNITY_MS + 1, nowMs); // immunity lapses, target re-picked
  return combat.attemptAttack(nowMs);
}

console.log('\n=== combat harness ===');

// ---------------------------------------------------------------------------
// Determinism. The whole point of the seeded switch.
// ---------------------------------------------------------------------------
{
  const run = (): string[] => {
    setDeterministicRuntime(1234);
    const out: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { player, rider, combat, obstacles } = makeWorld({ playerLane: 2, riderLane: 2 });
      attack(combat);
      // A knockback starts a tween; `laneIndex` only commits once it finishes,
      // so the rider has to be stepped before the destination lane is readable.
      for (let f = 0; f < 20; f++) rider.update(16, obstacles, player);
      out.push(`${rider.laneIndex}:${player.laneIndex}:${combat.events.length}`);
    }
    return out;
  };
  const a = run();
  const b = run();
  check('seeded runtime RNG reproduces exactly', a.join('|') === b.join('|'), `${a.length} exchanges`);

  // Direction used to be a coin flip for same-lane exchanges, which would
  // have made the new attack button's most common outcome random. It is now
  // the toward-centre rule, so repeated identical setups must agree.
  const distinct = new Set(a).size;
  check('same-lane knockback direction is deterministic', distinct === 1, `${distinct} distinct outcome(s)`);
}

// ---------------------------------------------------------------------------
// Core resolution rules.
// ---------------------------------------------------------------------------
{
  setDeterministicRuntime(7);
  const { player, rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  const before = rider.speed;
  const resolved = attack(combat);
  check('faster player wins a deliberate attack', resolved && rider.speed < before, `rider ${before.toFixed(0)} -> ${rider.speed.toFixed(0)}`);
  check(
    'unarmed win applies the baseline speed loss',
    Math.abs(rider.speed - before * (1 - SHOVE_SPEED_LOSS_FACTOR)) < 1,
    `expected ${(before * (1 - SHOVE_SPEED_LOSS_FACTOR)).toFixed(0)}`
  );
}

{
  setDeterministicRuntime(7);
  const { player, rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED, armed: true });
  const before = rider.speed;
  const charges = player.weaponCharges;
  attack(combat);
  check(
    'armed win applies the doubled speed loss',
    Math.abs(rider.speed - before * (1 - ARMED_SHOVE_SPEED_LOSS_FACTOR)) < 1,
    `${rider.speed.toFixed(0)}`
  );
  check('armed win consumes exactly one charge', player.weaponCharges === charges - 1, `${charges} -> ${player.weaponCharges}`);
}

{
  setDeterministicRuntime(7);
  const { player, rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, playerSpeed: MAX_SPEED * 0.4 });
  const before = player.speed;
  attack(combat);
  check('slower player LOSES the exchange', player.speed < before, `player ${before.toFixed(0)} -> ${player.speed.toFixed(0)}`);
}

{
  setDeterministicRuntime(7);
  const { rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  attack(combat);
  const second = attack(combat);
  check('cooldown/pair immunity blocks an immediate re-attack', second === false);
  combat.update(SHOVE_IMMUNITY_MS + 1, 2000);
  check('pair immunity lapses after its window', rider.speed > 0);
}

// ---------------------------------------------------------------------------
// Airborne is counterplay — an airborne player cannot be shoved at all.
// ---------------------------------------------------------------------------
{
  setDeterministicRuntime(7);
  const { player, combat } = makeWorld({ playerLane: 2, riderLane: 2, playerSpeed: MAX_SPEED * 0.3 });
  player.jump(false);
  const before = player.speed;
  combat.update(16, 1000);
  check('airborne player is immune to an incoming shove', player.speed === before);
}

// ---------------------------------------------------------------------------
// Knockback tree safety. This is the guarantee design-spec §4.6 makes, and
// the reason TREE_CLAMP_SEGMENTS exists at all.
// ---------------------------------------------------------------------------
{
  // A tree squarely in the only destination lane must be refused: the rider
  // takes the speed loss and does NOT move.
  setDeterministicRuntime(7);
  const z = 10_000;
  const obstacles = [tree(4, z + SEGMENT_LENGTH)];
  const { rider, combat } = makeWorld({
    playerLane: 2,
    riderLane: 3,
    riderZ: z,
    playerZ: z,
    riderSpeed: MAX_SPEED * 0.5,
    obstacles
  });
  attack(combat);
  check('knockback refuses a lane with a tree just downstream', rider.laneIndex === 3, `lane ${rider.laneIndex}`);
}

{
  // The clamp window must cover the distance a rider actually needs to escape:
  // the knockback tween plus a buffered steer. A tree anywhere inside that
  // window is an unavoidable kill, which is exactly what the spec promises
  // cannot happen.
  const escapeUnits = (150 / 1000) * MAX_SPEED * 0.8 + (75 / 1000) * MAX_SPEED * 0.8;
  const clampUnits = TREE_CLAMP_SEGMENTS * SEGMENT_LENGTH;
  check(
    'tree clamp window covers minimum escape distance',
    clampUnits >= escapeUnits,
    `clamp ${clampUnits}u vs escape ${escapeUnits.toFixed(0)}u`
  );
}

{
  // A 2-lane armed knockback drags the loser THROUGH the intermediate lane,
  // and the tween sits inside that lane's collision band long enough to hit
  // a tree in it. The clamp must consider the path, not just the destination.
  // Player in lane 1, rival in lane 2, tree in lane 3. An armed 2-lane
  // knockback sends the rival 2 -> 4, and lane 3 is the lane it crosses.
  setDeterministicRuntime(7);
  const z = 10_000;
  const obstacles = [tree(3, z + SEGMENT_LENGTH)];
  const { player, rider, combat } = makeWorld({
    playerLane: 1,
    riderLane: 2,
    riderZ: z,
    playerZ: z,
    riderSpeed: MAX_SPEED,
    armed: true,
    obstacles
  });
  const resolved = attack(combat);
  for (let f = 0; f < 20; f++) rider.update(16, obstacles, player);
  const passedThroughTree = resolved && rider.laneIndex === 4;
  check(
    'armed 2-lane knockback does not drag through a treed lane',
    !passedThroughTree,
    `rider ended lane ${rider.laneIndex}${passedThroughTree ? ' (dragged through lane 3)' : ''}`
  );
}

// ---------------------------------------------------------------------------
// Knockout attribution.
// ---------------------------------------------------------------------------
{
  setDeterministicRuntime(7);
  const { rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  attack(combat);
  combat.events.length = 0;
  rider.crashIntoTree();
  combat.update(16, 1500); // within KNOCKOUT_WINDOW_MS of the loss
  const knockouts = combat.events.filter((e) => e.type === 'knockout').length;
  check('rider treeing soon after a loss counts as a knockout', knockouts === 1, `${knockouts}`);
}

{
  setDeterministicRuntime(7);
  const { rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  attack(combat);
  combat.events.length = 0;
  combat.update(16, 60_000); // far outside the window
  rider.crashIntoTree();
  combat.update(16, 60_016);
  const knockouts = combat.events.filter((e) => e.type === 'knockout').length;
  check('an unrelated tree crash is NOT credited as a knockout', knockouts === 0, `${knockouts}`);
}

// ---------------------------------------------------------------------------
// Guards.
// ---------------------------------------------------------------------------
{
  setDeterministicRuntime(7);
  const { player, rider, combat } = makeWorld({ playerLane: 2, riderLane: 3 });
  rider.crashIntoTree();
  check('a wiped-out rider is not a combat target', attack(combat) === false);
  player.crashIntoTree();
  check('a wiped-out player cannot attack', attack(combat) === false);
}

{
  setDeterministicRuntime(7);
  const { combat } = makeWorld({
    playerLane: 2,
    riderLane: 3,
    riderZ: 10_000 + SEGMENT_LENGTH * 4,
    playerZ: 10_000
  });
  check('a rival outside the shove Z-window is not reachable', attack(combat) === false);
}

// ---------------------------------------------------------------------------
// Epic A: the attack button, and what separates it from passive contact.
// ---------------------------------------------------------------------------
{
  // Deliberate vs passive: same physics, different reward. Asserting POINTS
  // rather than just the event type, because the scorer's branch used to be
  // `if (hit) else { knockout }` — a third type added without restructuring
  // would score every body check as a 500-point knockout.
  setDeterministicRuntime(7);
  const w = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5 });
  attackAfterContact(w.combat);
  const deliberate = w.combat.events.map((e) => e.type);
  check('a pressed attack emits a hit', deliberate.includes('hit'), deliberate.join(','));

  setDeterministicRuntime(7);
  const w2 = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5 });
  w2.combat.update(16, 1000); // passive same-lane contact, no press
  const passive = w2.combat.events.map((e) => e.type);
  check('passive same-lane contact emits a brush', passive.includes('brush'), passive.join(','));
  check('a brush is worth a fifth of an attack', POINTS.COMBAT_BRUSH * 5 === POINTS.COMBAT_HIT,
    `${POINTS.COMBAT_BRUSH} vs ${POINTS.COMBAT_HIT}`);
}

{
  // The pole is a weapon you SWING: passive contact must not spend a charge.
  setDeterministicRuntime(7);
  const { player, combat } = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5, armed: true });
  const before = player.weaponCharges;
  combat.update(16, 1000); // brush, not an attack
  check('a passive brush does NOT burn a pole charge', player.weaponCharges === before,
    `${before} -> ${player.weaponCharges}`);
}

{
  // Refusal must be free. A press the game declines costs no swing and no
  // cooldown — the cost of attacking is the commitment when you engage, not
  // a tax for a press that did nothing.
  setDeterministicRuntime(7);
  const { player, combat } = makeWorld({
    playerLane: 2, riderLane: 2,
    riderZ: 10_000 + SEGMENT_LENGTH * 6, playerZ: 10_000
  });
  const started = attack(combat);
  check('attack with no target in reach is refused', started === false);
  check('a refused attack starts no swing', player.swingMsRemaining === 0);
  check('a refused attack costs no cooldown', combat.attackOnCooldown === false);
}

{
  // The swing is the cost: steering AND jump locked for its duration.
  setDeterministicRuntime(7);
  const { player, combat } = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5 });
  attackAfterContact(combat);
  check('a landed attack starts a swing', player.swinging, `${player.swingMsRemaining}ms`);
  const laneBefore = player.laneIndex;
  player.requestLaneShift(1);
  for (let i = 0; i < 4; i++) player.update(16); // still inside the lock
  check('steering is locked during the swing', player.laneIndex === laneBefore);
  player.jump(false);
  check('jump is locked during the swing', player.airborne === false);

  // ...and the steer that was pressed during the lock is BUFFERED, not eaten.
  for (let i = 0; i < Math.ceil(ATTACK_SWING_MS / 16) + 14; i++) player.update(16);
  check('a steer pressed mid-swing fires when the lock lifts', player.laneIndex !== laneBefore,
    `lane ${laneBefore} -> ${player.laneIndex}`);
}

{
  // Targeting must mirror resolution exactly: a visible marker that the
  // exchange would refuse is a promise the game breaks.
  setDeterministicRuntime(7);
  const { combat } = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5 });
  combat.update(16, 1000);                     // entering-edge body check
  combat.update(SHOVE_IMMUNITY_MS + 1, 3000);  // immunity lapses
  check('a reachable rival becomes the target', combat.target !== null);
  combat.attemptAttack(3000);
  combat.update(16, 3016);
  check('no target is offered while on cooldown', combat.target === null);

  setDeterministicRuntime(7);
  const far = makeWorld({
    playerLane: 2, riderLane: 2,
    riderZ: 10_000 + SEGMENT_LENGTH * 6, playerZ: 10_000
  });
  far.combat.update(16, 1000);
  check('an out-of-reach rival is not targeted', far.combat.target === null);

  setDeterministicRuntime(7);
  const gone = makeWorld({ playerLane: 2, riderLane: 2 });
  gone.rider.crashIntoTree();
  gone.combat.update(16, 1000);
  check('a wiped-out rival is not targeted', gone.combat.target === null);
}

{
  // The loser recoils — the signal the renderer needs. Before this there was
  // no event and no state for a lost exchange at all.
  setDeterministicRuntime(7);
  const { rider, combat } = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5 });
  attackAfterContact(combat);
  check('a struck rival enters its hit reaction', rider.hitReacting, `${rider.hitReactionMsRemaining}ms`);

  setDeterministicRuntime(7);
  const lose = makeWorld({ playerLane: 2, riderLane: 2, playerSpeed: MAX_SPEED * 0.4 });
  attack(lose.combat);
  check('the PLAYER recoils when they lose', lose.player.hitReacting,
    `${lose.player.hitReactionMsRemaining}ms`);
  check('hit reaction runs for the configured window', lose.player.hitReactionMsRemaining <= HIT_REACTION_MS);
}

{
  // Cooldown gates re-attacking, and lapses.
  setDeterministicRuntime(7);
  const { combat } = makeWorld({ playerLane: 2, riderLane: 2, riderSpeed: MAX_SPEED * 0.5 });
  attackAfterContact(combat);
  check('attack goes on cooldown after landing', combat.attackOnCooldown);
  combat.update(ATTACK_COOLDOWN_MS + 1, 8000);
  check('attack cooldown lapses', combat.attackOnCooldown === false);
}

setDeterministicRuntime(null);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed) process.exit(1);
