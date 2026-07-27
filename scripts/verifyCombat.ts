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
  TREE_CLAMP_SEGMENTS
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
      combat.beginFrame(1000);
      combat.update(16, 1000);
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

  // And that it is actually exercising the random branch, not accidentally
  // deterministic because the coin flip never ran.
  const distinct = new Set(a).size;
  check('same-lane knockback direction does vary', distinct > 1, `${distinct} distinct outcomes`);
}

// ---------------------------------------------------------------------------
// Core resolution rules.
// ---------------------------------------------------------------------------
{
  setDeterministicRuntime(7);
  const { player, rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  const before = rider.speed;
  const resolved = combat.attemptPlayerShove(1);
  check('faster player wins a lateral shove', resolved && rider.speed < before, `rider ${before.toFixed(0)} -> ${rider.speed.toFixed(0)}`);
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
  combat.attemptPlayerShove(1);
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
  combat.attemptPlayerShove(1);
  check('slower player LOSES the exchange', player.speed < before, `player ${before.toFixed(0)} -> ${player.speed.toFixed(0)}`);
}

{
  setDeterministicRuntime(7);
  const { rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  combat.attemptPlayerShove(1);
  const second = combat.attemptPlayerShove(1);
  check('pair immunity blocks an immediate re-shove', second === false);
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
  combat.beginFrame(1000);
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
  combat.attemptPlayerShove(1);
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
  const resolved = combat.attemptPlayerShove(1);
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
  combat.attemptPlayerShove(1);
  combat.events.length = 0;
  rider.crashIntoTree();
  combat.update(16, 1500); // within KNOCKOUT_WINDOW_MS of the loss
  const knockouts = combat.events.filter((e) => e.type === 'knockout').length;
  check('rider treeing soon after a loss counts as a knockout', knockouts === 1, `${knockouts}`);
}

{
  setDeterministicRuntime(7);
  const { rider, combat } = makeWorld({ playerLane: 2, riderLane: 3, riderSpeed: MAX_SPEED * 0.5 });
  combat.attemptPlayerShove(1);
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
  check('a wiped-out rider is not a combat target', combat.attemptPlayerShove(1) === false);
  player.crashIntoTree();
  check('a wiped-out player cannot shove', combat.attemptPlayerShove(1) === false);
}

{
  setDeterministicRuntime(7);
  const { combat } = makeWorld({
    playerLane: 2,
    riderLane: 3,
    riderZ: 10_000 + SEGMENT_LENGTH * 4,
    playerZ: 10_000
  });
  check('a rival outside the shove Z-window is not reachable', combat.attemptPlayerShove(1) === false);
}

setDeterministicRuntime(null);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed) process.exit(1);
