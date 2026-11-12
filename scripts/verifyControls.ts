/** Deterministic controls regression suite. No browser, GPU, or Phaser runtime. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { ATTACK_SWING_MS, JUMP_AIRTIME_MS, LANE_TWEEN_MS, PLAYER_START_Z, ROCK_TUMBLE_MS } from '../src/config';
import { ACTION_BUFFER_MS, MAX_FRESH_FRAME_MS, bindPlayerInput, PlayerInputController, STEER_REPEAT_DELAY_MS, STEER_REPEAT_MS } from '../src/entities/input';
import { Player } from '../src/entities/player';
import { oncePerKeyEvent } from '../src/input/keyboardEvents';

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
check('revisited DOM queue cannot toggle a lifecycle action twice', () => {
  let paused = false;
  const pause = oncePerKeyEvent(() => { paused = !paused; });
  const press = { code: 'KeyP', type: 'keydown' } as KeyboardEvent;
  pause(press);
  pause(press); // Same Pdown replayed after Pup and an unrelated ArrowLeft.
  assert.equal(paused, true);
  pause({ code: 'KeyP', type: 'keydown' } as KeyboardEvent);
  assert.equal(paused, false); // A genuinely new press still resumes.
});
check('replayed down/up pairs cannot resurrect released steering or attack', () => {
  const keyboard = Object.assign(new EventEmitter(), {
    addKey: (name: string) => ({ name }), removeKey: () => undefined, removeCapture: () => undefined
  });
  const events = new EventEmitter();
  const scene = { input: { keyboard }, events, game: { events: new EventEmitter() } } as unknown as Phaser.Scene;
  const player = new Player();
  const input = bindPlayerInput(scene, player);
  const down = { code: 'KeyD', repeat: false };
  const up = { code: 'KeyD' };
  const hit = { code: 'KeyF', repeat: false };
  const hitUp = { code: 'KeyF' };
  keyboard.emit('keydown', down); keyboard.emit('keyup', up);
  keyboard.emit('keydown', hit); keyboard.emit('keyup', hitUp);
  input.update(16);
  assert.equal(input.attackJustPressed(), true);
  player.update(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3);
  // A slow render frame allows Phaser to deliver the very same event objects again.
  keyboard.emit('keydown', down); keyboard.emit('keyup', up);
  keyboard.emit('keydown', hit); keyboard.emit('keyup', hitUp);
  input.update(16); player.update(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3);
  assert.equal(input.attackJustPressed(), false);
  events.emit('shutdown');
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
check('a complete quick touch tap survives its first slow render frame exactly once', () => {
  const { player, input, age } = rig();
  input.setAction('right', true, 'touch:1');
  age(30);
  input.setAction('right', false, 'touch:1');
  age(210); //240ms wall time elapsed; physics still advances at most50ms.
  input.update(50, 250);
  assert.equal(player.leanDirection, 1);
  player.update(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3);
  age(250);
  input.update(50, 250);
  player.update(LANE_TWEEN_MS);
  assert.equal(player.laneIndex, 3);
  assert.equal(player.leanDirection, 0);
});
check('fresh jump and attack taps get the same first-frame opportunity', () => {
  const { player, input, age } = rig();
  input.setAction('jump', true, 'touch:2');
  input.setAction('jump', false, 'touch:2');
  input.setAction('attack', true, 'touch:3');
  input.setAction('attack', false, 'touch:3');
  age(390);
  input.update(50, 400);
  assert.equal(player.airborne, true);
  assert.equal(input.attackJustPressed(), true);
  assert.equal(input.attackJustPressed(), false);
});
check('older-frame hit-stop taps cannot borrow the latest slow frame budget', () => {
  const { player, input, age } = rig();
  for (const action of ['right', 'jump', 'attack'] as const) {
    input.setAction(action, true); input.setAction(action, false);
  }
  age(410); //Multiple skipped hit-stop frames; latest frame was only200ms.
  input.update(50, 200);
  assert.equal(player.leanDirection, 0);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
});
check('a previously observed locked jump retains its original 160ms deadline', () => {
  const { player, input, age } = rig();
  player.jump(false);
  player.update(JUMP_AIRTIME_MS - 100);
  input.setAction('jump', true); input.setAction('jump', false);
  age(60);
  input.update(50, 400); //Observed while locked, within ordinary forgiveness.
  player.update(100); //Land before the following update.
  age(120); //180ms since press, despite a large current render interval.
  input.update(50, 400);
  assert.equal(player.airborne, false);
});
check('a slow-frame first observation cannot create a new jump buffer while locked', () => {
  const { player, input, age } = rig();
  player.startSwing();
  input.setAction('jump', true); input.setAction('jump', false);
  age(220);
  input.update(50, 250); //The first chance was valid, but swing still locks jump.
  player.update(ATTACK_SWING_MS);
  age(20);
  input.update(50, 250);
  assert.equal(player.airborne, false);
});
check('fresh-frame forgiveness is capped even after a multi-second hitch', () => {
  const { player, input, age } = rig();
  for (const action of ['left', 'jump', 'attack'] as const) {
    input.setAction(action, true); input.setAction(action, false);
  }
  age(MAX_FRESH_FRAME_MS + 1);
  input.update(50, 5000);
  assert.equal(player.leanDirection, 0);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
});
check('invalid render intervals never create an unlimited input deadline', () => {
  for (const frameElapsed of [NaN, Infinity, -100]) {
    const { player, input, age } = rig();
    input.setAction('right', true); input.setAction('right', false);
    age(ACTION_BUFFER_MS + 1);
    input.update(50, frameElapsed);
    assert.equal(player.leanDirection, 0);
  }
});
check('pause still discards a pending tap even inside the extended fresh-frame budget', () => {
  const { player, input, age } = rig();
  input.setAction('right', true); input.setAction('right', false);
  input.setAction('jump', true); input.setAction('jump', false);
  input.setAction('attack', true); input.setAction('attack', false);
  age(100);
  input.setEnabled(false);
  age(100);
  input.setEnabled(true);
  input.update(50, 400);
  assert.equal(player.leanDirection, 0);
  assert.equal(player.airborne, false);
  assert.equal(input.attackJustPressed(), false);
});
check('boost is held, not edge-triggered, from every keyboard binding and touch', () => {
  const { input } = rig();
  for (const source of ['ShiftLeft', 'ShiftRight', 'KeyS', 'ArrowDown', 'touch:3']) {
    assert.equal(input.boostHeld(), false);
    input.setAction('boost', true, source);
    assert.equal(input.boostHeld(), true, source);
    input.update(16);
    assert.equal(input.boostHeld(), true, `${source} stays held across frames`);
    input.setAction('boost', false, source);
    assert.equal(input.boostHeld(), false, source);
  }
  input.setAction('boost', true, 'ShiftLeft'); input.setAction('boost', true, 'touch:1');
  input.setAction('boost', false, 'ShiftLeft');
  assert.equal(input.boostHeld(), true, 'releasing one source leaves the other holding');
});
check('pause, blur and wipeout never leave boost stuck on', () => {
  const paused = rig();
  paused.input.setAction('boost', true, 'ShiftLeft');
  paused.input.setEnabled(false);
  assert.equal(paused.input.boostHeld(), false);
  paused.input.setEnabled(true);
  assert.equal(paused.input.boostHeld(), false, 'a key held across resume must be released first');
  paused.input.setAction('boost', false, 'ShiftLeft');
  paused.input.setAction('boost', true, 'ShiftLeft');
  assert.equal(paused.input.boostHeld(), true);
  paused.input.reset();
  assert.equal(paused.input.boostHeld(), false, 'CANCEL_INPUT / reset releases boost');
  const blurred = rig();
  blurred.input.setAction('boost', true, 'touch:2');
  blurred.input.setFocused(false);
  assert.equal(blurred.input.boostHeld(), false);
  blurred.input.setFocused(true);
  assert.equal(blurred.input.boostHeld(), false, 'refocus does not resurrect a held boost');
  blurred.input.setAction('boost', true, 'touch:2');
  assert.equal(blurred.input.boostHeld(), true);
  const wiped = rig();
  wiped.input.setAction('boost', true, 'KeyS');
  wiped.player.crashIntoTree(); wiped.player.crashIntoTree(); // second strike: wiped out
  assert.equal(wiped.input.boostHeld(), false);
});
check('boost never queues a jump, steer or attack', () => {
  const { player, input, advance } = rig();
  input.setAction('boost', true, 'ShiftLeft');
  advance(16);
  assert.equal(player.airborne, false);
  assert.equal(player.leanDirection, 0);
  assert.equal(input.attackJustPressed(), false);
});
check('shove is its own edge-triggered action: consumed once, never repeats, independent of attack', () => {
  const { input, advance, age } = rig();
  input.setAction('push', true, 'KeyG');
  advance(16, false);
  assert.equal(input.attackJustPressed(), false, 'a shove press is not an attack press');
  assert.equal(input.pushJustPressed(), true);
  assert.equal(input.pushJustPressed(), false);
  for (let i = 0; i < 20; i++) {
    input.setAction('push', true, 'KeyG');
    advance(50, false);
    assert.equal(input.pushJustPressed(), false);
  }
  input.setAction('push', false, 'KeyG');
  input.setAction('push', true, 'KeyL');
  advance(16, false);
  assert.equal(input.pushJustPressed(), true, 'L is a second binding of the same action');
  input.setAction('attack', true, 'KeyF');
  advance(16, false);
  assert.equal(input.pushJustPressed(), false);
  assert.equal(input.attackJustPressed(), true);
  input.setAction('push', false, 'KeyL');
  input.setAction('push', true, 'KeyG');
  input.setAction('push', false, 'KeyG');
  age(ACTION_BUFFER_MS + 1);
  advance(0, false);
  assert.equal(input.pushJustPressed(), false, 'a stale shove tap expires like a stale attack');
});
check('the held steer direction is exposed for the same-lane shove rule', () => {
  const { input, advance } = rig();
  assert.equal(input.heldDirection(), 0);
  input.setAction('left', true, 'ArrowLeft');
  assert.equal(input.heldDirection(), -1);
  input.setAction('right', true, 'KeyD');
  assert.equal(input.heldDirection(), 0, 'both held cancels');
  input.setAction('left', false, 'ArrowLeft');
  assert.equal(input.heldDirection(), 1);
  input.setEnabled(false);
  assert.equal(input.heldDirection(), 0, 'nothing counts as held while disabled');
  input.setEnabled(true);
  input.setAction('right', false, 'KeyD');
  advance(16, false);
  assert.equal(input.heldDirection(), 0);
});
check('G and L are bound to the shove, and K is still the jab', () => {
  const keyboard = Object.assign(new EventEmitter(), {
    addKey: (name: string) => ({ name }), removeKey: () => undefined, removeCapture: () => undefined
  });
  const scene = { input: { keyboard }, events: new EventEmitter(), game: { events: new EventEmitter() } } as unknown as Phaser.Scene;
  const input = bindPlayerInput(scene, new Player());
  for (const code of ['KeyG', 'KeyL']) {
    keyboard.emit('keydown', { code, repeat: false });
    input.update(16);
    assert.equal(input.pushJustPressed(), true, `${code} presses shove`);
    assert.equal(input.attackJustPressed(), false);
    keyboard.emit('keyup', { code });
  }
  keyboard.emit('keydown', { code: 'KeyK', repeat: false });
  input.update(16);
  assert.equal(input.pushJustPressed(), false);
  assert.equal(input.attackJustPressed(), true, 'K is still the jab');
  input.destroy();
});
check('strike is its own edge-triggered touch action, independent of attack and shove', () => {
  const { input, advance, age } = rig();
  input.setAction('strike', true, 'touch:1');
  advance(16, false);
  assert.equal(input.attackJustPressed(), false, 'a strike press is not an attack press');
  assert.equal(input.pushJustPressed(), false, 'a strike press is not a shove press');
  assert.equal(input.strikeJustPressed(), true);
  assert.equal(input.strikeJustPressed(), false, 'consumed once');
  for (let i = 0; i < 20; i++) {
    input.setAction('strike', true, 'touch:1');
    advance(50, false);
    assert.equal(input.strikeJustPressed(), false, 'holding never repeats');
  }
  input.setAction('strike', false, 'touch:1');
  input.setAction('attack', true, 'KeyF');
  input.setAction('push', true, 'KeyG');
  advance(16, false);
  assert.equal(input.strikeJustPressed(), false, 'keys never produce a strike');
  assert.equal(input.attackJustPressed(), true);
  assert.equal(input.pushJustPressed(), true);
  input.setAction('strike', true, 'touch:2');
  input.setAction('strike', false, 'touch:2');
  age(ACTION_BUFFER_MS + 1);
  advance(0, false);
  assert.equal(input.strikeJustPressed(), false, 'a stale strike tap expires like a stale attack');
});
check('pause, blur, CANCEL_INPUT (reset) and disabling clear a pending or held strike', () => {
  const pending = rig();
  pending.input.setAction('strike', true, 'touch:1');
  pending.input.reset(); // what the scene runs on CANCEL_INPUT and on resume
  pending.advance(16, false);
  assert.equal(pending.input.strikeJustPressed(), false, 'reset forgets a press not yet polled');
  pending.input.setAction('strike', false, 'touch:1');
  pending.input.setAction('strike', true, 'touch:1');
  pending.advance(16, false);
  assert.equal(pending.input.strikeJustPressed(), true, 'a fresh tap after the reset works');
  const held = rig();
  held.input.setAction('strike', true, 'touch:3');
  held.input.setEnabled(false);
  held.input.setEnabled(true);
  held.advance(16, false);
  assert.equal(held.input.strikeJustPressed(), false, 'a strike held across pause is not a new press on resume');
  const blurred = rig();
  blurred.input.setAction('strike', true, 'touch:4');
  blurred.input.setFocused(false);
  blurred.input.setFocused(true);
  blurred.advance(16, false);
  assert.equal(blurred.input.strikeJustPressed(), false, 'blur drops a pending strike');
  const disabled = rig();
  disabled.input.setEnabled(false);
  disabled.input.setAction('strike', true, 'touch:5');
  disabled.input.setEnabled(true);
  disabled.advance(16, false);
  assert.equal(disabled.input.strikeJustPressed(), false, 'a strike pressed while paused is not queued');
  const gone = rig();
  gone.input.setAction('strike', true, 'touch:6');
  gone.input.destroy();
  assert.equal(gone.input.strikeJustPressed(), false);
});
check('keyboard is unchanged: F/K stay the jab, G/L stay the shove, none ever raises a strike', () => {
  const keyboard = Object.assign(new EventEmitter(), {
    addKey: (name: string) => ({ name }), removeKey: () => undefined, removeCapture: () => undefined
  });
  const scene = { input: { keyboard }, events: new EventEmitter(), game: { events: new EventEmitter() } } as unknown as Phaser.Scene;
  const input = bindPlayerInput(scene, new Player());
  for (const code of ['KeyF', 'KeyK', 'KeyG', 'KeyL']) {
    keyboard.emit('keydown', { code, repeat: false });
    input.update(16);
    assert.equal(input.strikeJustPressed(), false, `${code} is not a strike`);
    assert.equal(input.attackJustPressed(), code === 'KeyF' || code === 'KeyK', `${code} attack`);
    assert.equal(input.pushJustPressed(), code === 'KeyG' || code === 'KeyL', `${code} shove`);
    keyboard.emit('keyup', { code });
  }
  input.setAction('strike', true, 'touch:1');
  input.update(16);
  assert.equal(input.strikeJustPressed(), true, 'the bound input exposes the touch strike');
  input.destroy();
});
console.log(`\n=== ${checks} control regressions passed ===\n`);
