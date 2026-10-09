/** Deterministic controls regression suite. No browser, GPU, or Phaser runtime. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { ATTACK_SWING_MS, JUMP_AIRTIME_MS, LANE_TWEEN_MS, PLAYER_START_Z, ROCK_TUMBLE_MS } from '../src/config';
import { ACTION_BUFFER_MS, bindPlayerInput, PlayerInputController, STEER_REPEAT_DELAY_MS, STEER_REPEAT_MS } from '../src/entities/input';
import { Player } from '../src/entities/player';

let checks = 0;
function check(name: string, run: () => void): void {
  run();
  checks++;
  console.log(`  ✓ ${name}`);
}

function rig(onJump?: (player: Player) => void) {
  const player = new Player();
  let time = 0;
  const input = new PlayerInputController(player, () => onJump ? onJump(player) : player.requestJump(), () => time);
  const advance = (delta: number, move = true) => {
    time += delta;
    input.update(delta);
    if (move) player.update(delta);
  };
  return { player, input, advance, age: (delta: number) => { time += delta; } };
}

console.log('\n=== responsive controls ===');
check('events record intent without advancing or moving a waiting rider', () => {
  const { player, input } = rig();
  input.setAction('right', true);
  input.setAction('jump', true);
  input.setAction('attack', true);
  assert.equal(player.worldZ, PLAYER_START_Z);
  assert.equal(player.speed, 0);
  assert.equal(player.leanDirection, 0);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
});
check('a complete tap between frames is preserved exactly once', () => {
  const { player, input, advance } = rig();
  input.setAction('right', true);
  input.setAction('right', false);
  advance(16);
  assert.equal(player.leanDirection, 1);
  advance(LANE_TWEEN_MS);
  advance(500);
  assert.equal(player.laneIndex, 3);
});
check('held steering repeats on game timing, not keydown or OS repeat', () => {
  const { player, input, advance } = rig();
  input.setAction('left', true);
  advance(0, false);
  for (let i = 0; i < 40; i++) input.setAction('left', true);
  advance(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 1);
  assert.equal(player.leanDirection, 0);
  advance(STEER_REPEAT_DELAY_MS - LANE_TWEEN_MS - 1);
  assert.equal(player.leanDirection, 0);
  advance(1, false);
  assert.equal(player.leanDirection, -1);
  input.setAction('left', false);
  advance(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 0);
  advance(STEER_REPEAT_MS * 4);
  assert.equal(player.laneIndex, 0);
});
check('a frame hitch cannot manufacture a multi-lane steering backlog', () => {
  const { player, input, advance } = rig();
  input.setAction('right', true);
  advance(0, false);
  advance(2000);
  input.setAction('right', false);
  advance(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3, 'one update can only complete one lane tween');
  assert.equal(player.leanDirection, 0);
  advance(2000);
  assert.equal(player.leanDirection, 0);
});
check('opposing directions cancel; releasing one honors the remaining hold', () => {
  const { player, input, advance } = rig();
  input.setAction('left', true);
  input.setAction('right', true);
  advance(16);
  assert.equal(player.leanDirection, 0);
  input.setAction('right', false);
  advance(16);
  assert.equal(player.leanDirection, -1);
});
check('aliases and independent pointers do not prematurely release a hold', () => {
  const { player, input, advance } = rig();
  input.setAction('right', true, 'KeyD');
  input.setAction('right', true, 'touch:1');
  input.setAction('right', false, 'KeyD');
  advance(0, false);
  advance(LANE_TWEEN_MS);
  advance(STEER_REPEAT_DELAY_MS);
  advance(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 4);
});
check('attack is consumed once and a held attack never repeats', () => {
  const { input, advance } = rig();
  input.setAction('attack', true);
  advance(16, false);
  assert.equal(input.attackJustPressed(), true);
  assert.equal(input.attackJustPressed(), false);
  for (let i = 0; i < 20; i++) {
    input.setAction('attack', true);
    advance(50, false);
    assert.equal(input.attackJustPressed(), false);
  }
  input.setAction('attack', false);
  input.setAction('attack', true);
  advance(16, false);
  assert.equal(input.attackJustPressed(), true);
});
check('brief hit-stop preserves taps but stale taps expire', () => {
  const { player, input, age, advance } = rig();
  input.setAction('attack', true);
  input.setAction('attack', false);
  age(50);
  advance(16, false);
  assert.equal(input.attackJustPressed(), true);
  input.setAction('attack', true);
  input.setAction('attack', false);
  input.setAction('jump', true);
  input.setAction('jump', false);
  input.setAction('left', true);
  input.setAction('left', false);
  age(ACTION_BUFFER_MS + 1);
  advance(0, false);
  assert.equal(input.attackJustPressed(), false);
  assert.equal(player.airborne, false);
  assert.equal(player.leanDirection, 0);
});
check('a late jump queues through landing and reevaluates launch at execution', () => {
  let extended = false;
  let launches = 0;
  const { player, input, advance } = rig((p) => { launches++; p.jump(extended); });
  player.jump(false);
  player.update(JUMP_AIRTIME_MS - 80);
  input.setAction('jump', true);
  advance(40);
  assert.equal(launches, 0);
  advance(40);
  extended = true;
  advance(16);
  assert.equal(launches, 1);
  assert.equal(player.airborne, true);
  assert.equal(player.extendedJump, true);
  advance(1300);
  advance(16);
  assert.equal(launches, 1, 'holding jump must not bunny-hop');
});
check('an early jump expires rather than unexpectedly firing at landing', () => {
  const { player, input, advance } = rig();
  player.jump(false);
  input.setAction('jump', true);
  input.setAction('jump', false);
  advance(ACTION_BUFFER_MS + 1);
  advance(JUMP_AIRTIME_MS);
  advance(16);
  assert.equal(player.airborne, false);
});
check('late lane presses survive landing, early airborne presses expire', () => {
  const late = new Player();
  late.jump(false);
  late.update(JUMP_AIRTIME_MS - 80);
  late.requestLaneShift(1);
  late.update(80);
  assert.equal(late.leanDirection, 1);
  late.update(LANE_TWEEN_MS);
  assert.equal(late.laneIndex, 3);
  const early = new Player();
  early.jump(false);
  early.requestLaneShift(1);
  early.update(JUMP_AIRTIME_MS);
  early.update(LANE_TWEEN_MS);
  assert.equal(early.laneIndex, 2);
});
check('late recovery steer works, but a tumble never permits jump escape', () => {
  const player = new Player();
  player.hitRock();
  player.jump(false);
  assert.equal(player.airborne, false);
  player.requestLaneShift(-1);
  player.update(ROCK_TUMBLE_MS - 80);
  assert.equal(player.leanDirection, 0);
  player.requestLaneShift(1);
  player.update(80);
  assert.equal(player.leanDirection, 1);
  player.update(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3);
});
check('attack still locks jump and steer for the full commitment', () => {
  const player = new Player();
  player.startSwing();
  player.requestLaneShift(1);
  player.jump(false);
  player.update(ATTACK_SWING_MS - 1);
  assert.equal(player.airborne, false);
  assert.equal(player.leanDirection, 0);
  player.update(1);
  assert.equal(player.leanDirection, 1);
  assert.equal(player.laneIndex, 2, 'new steer cannot consume past locked time');
  player.update(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3);
});
check('finishing an old lane tween cannot release a buffered steer mid-swing', () => {
  const player = new Player();
  player.requestLaneShift(1);
  player.update(50);
  player.startSwing();
  player.requestLaneShift(-1);
  player.update(100);
  assert.equal(player.laneIndex, 3);
  assert.equal(player.leanDirection, 0);
  player.update(ATTACK_SWING_MS - 100);
  assert.equal(player.leanDirection, -1);
});
check('pause flushes pending actions and requires held controls to release', () => {
  const { player, input, advance } = rig();
  input.setAction('right', true);
  input.setAction('jump', true);
  input.setAction('attack', true);
  input.setEnabled(false);
  advance(1000, false);
  input.setEnabled(true);
  advance(1000, false);
  assert.equal(player.leanDirection, 0);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
  input.setAction('right', false);
  input.setAction('right', true);
  advance(16, false);
  assert.equal(player.leanDirection, 1);
});
check('presses made during countdown never execute after GO', () => {
  const { player, input, advance } = rig();
  input.setEnabled(false);
  input.setAction('jump', true);
  input.setAction('right', true);
  input.setAction('attack', true);
  input.setEnabled(true);
  advance(50, false);
  assert.equal(player.worldZ, PLAYER_START_Z);
  assert.equal(player.leanDirection, 0);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
});
check('blur is independently gated and refocus cannot unpause the race', () => {
  const { player, input, advance } = rig();
  input.setFocused(false);
  input.setAction('jump', true);
  input.setAction('attack', true);
  advance(16, false);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
  input.setEnabled(false);
  input.setFocused(true);
  input.setAction('right', true);
  advance(16, false);
  assert.equal(player.leanDirection, 0);
});
check('reset clears player-owned buffered steering; destruction is inert', () => {
  const { player, input, advance } = rig();
  player.startSwing();
  player.requestLaneShift(1);
  input.reset();
  advance(ATTACK_SWING_MS + LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 2);
  input.destroy();
  input.setAction('jump', true);
  input.setEnabled(true);
  advance(16, false);
  assert.equal(player.airborne, false);
});
check('keyboard W works, repeats are ignored, and shutdown removes all listeners', () => {
  const keyboard = new EventEmitter() as EventEmitter & {
    addKey: (name: string) => { name: string };
    removeKey: (key: { name: string }) => void;
    removeCapture: (names: string[]) => void;
  };
  const registered: string[] = [];
  const removed: string[] = [];
  keyboard.addKey = (name) => { registered.push(name); return { name }; };
  keyboard.removeKey = (key) => { removed.push(key.name); };
  let captureRemovals = 0;
  keyboard.removeCapture = (names) => { assert.deepEqual(names, registered); captureRemovals++; };
  const events = new EventEmitter();
  const gameEvents = new EventEmitter();
  const scene = { input: { keyboard }, events, game: { events: gameEvents } } as unknown as Phaser.Scene;
  const player = new Player();
  const input = bindPlayerInput(scene, player);
  keyboard.emit('keydown', { code: 'KeyW', repeat: false });
  assert.equal(player.airborne, false);
  input.update(16);
  assert.equal(player.airborne, true);
  player.update(JUMP_AIRTIME_MS);
  keyboard.emit('keydown', { code: 'KeyW', repeat: true });
  input.update(16);
  assert.equal(player.airborne, false);
  gameEvents.emit('blur');
  keyboard.emit('keyup', { code: 'KeyW' });
  keyboard.emit('keydown', { code: 'KeyW', repeat: false });
  input.update(16);
  assert.equal(player.airborne, false);
  events.emit('shutdown');
  assert.equal(keyboard.listenerCount('keydown'), 0);
  assert.equal(keyboard.listenerCount('keyup'), 0);
  assert.equal(gameEvents.listenerCount('blur'), 0);
  assert.equal(gameEvents.listenerCount('focus'), 0);
  assert.equal(events.listenerCount('pause'), 0);
  assert.deepEqual(removed, registered);
  input.destroy();
  assert.equal(removed.length, registered.length);
  assert.equal(captureRemovals, 1);
});
check('a release during a real scene pause is observed outside Phaser', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const dom = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
  const keyboard = Object.assign(new EventEmitter(), {
    addKey: (name: string) => ({ name }),
    removeKey: () => undefined,
    removeCapture: () => undefined
  });
  const events = new EventEmitter();
  const gameEvents = new EventEmitter();
  const scene = { input: { keyboard }, events, game: { events: gameEvents } } as unknown as Phaser.Scene;
  const player = new Player();
  const input = bindPlayerInput(scene, player);
  try {
    keyboard.emit('keydown', { code: 'KeyD', repeat: false });
    events.emit('pause');
    // The scene's KeyboardPlugin receives nothing during this interval.
    const release = new Event('keyup');
    Object.defineProperty(release, 'code', { value: 'KeyD' });
    dom.dispatchEvent(release);
    input.setEnabled(true);
    keyboard.emit('keydown', { code: 'KeyD', repeat: false });
    input.update(16);
    assert.equal(player.leanDirection, 1);
    events.emit('shutdown');
    // No shutdown listener can write to the destroyed controller.
    dom.dispatchEvent(new Event('blur'));
  } finally {
    input.destroy();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
check('touch-only scenes work with no keyboard plugin', () => {
  const events = new EventEmitter();
  const gameEvents = new EventEmitter();
  const scene = { input: { keyboard: null }, events, game: { events: gameEvents } } as unknown as Phaser.Scene;
  const player = new Player();
  const input = bindPlayerInput(scene, player);
  input.setAction('jump', true, 'touch:2');
  input.update(16);
  assert.equal(player.airborne, true);
  events.emit('shutdown');
  assert.equal(gameEvents.listenerCount('blur'), 0);
});
console.log(`\n=== ${checks} control regressions passed ===\n`);
