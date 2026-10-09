import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AppPlugin } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import type Phaser from 'phaser';
import { getRaceAudio } from '../src/audio/RaceAudio';
import { APP_ACTIVE, APP_INACTIVE, CANCEL_INPUT, installAppLifecycle, isAppActive } from '../src/input/appLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const domWindow = new EventTarget();
const domDocument = Object.assign(new EventTarget(), { hidden: false });
Object.defineProperty(globalThis, 'window', { configurable: true, value: domWindow });
Object.defineProperty(globalThis, 'document', { configurable: true, value: domDocument });
const audio = getRaceAudio();
const originalActive = audio.setActive;
const originalUnlock = audio.unlock;
let audioActive = true, gestures = 0;
audio.setActive = value => { audioActive = value; };
audio.unlock = () => { gestures++; };

function rig(nativeApp: Parameters<typeof installAppLifecycle>[1]) {
  let cancels = 0, inactive = 0, active = 0, resets = 0;
  let paused = false;
  const events = new EventEmitter();
  const canvas = new EventTarget();
  const keyboard = { queue: [{ code: 'KeyP' }] };
  const game = { events, canvas, input: { pointers: [{ reset: () => { resets++; } }], keyboard } } as unknown as Phaser.Game;
  events.on(CANCEL_INPUT, () => { cancels++; });
  events.on(APP_INACTIVE, () => { inactive++; paused = true; });
  events.on(APP_ACTIVE, () => { active++; });
  installAppLifecycle(game, nativeApp);
  return { game, events, canvas, keyboard, get: () => ({ cancels, inactive, active, resets, paused }) };
}

try {
  let listener!: (state: { isActive: boolean }) => void;
  let adds = 0, removes = 0, reads = 0;
  const snapshot = deferred<{ isActive: boolean }>();
  const nativeApp = {
    addListener: async (name: string, callback: typeof listener) => {
      assert.equal(name, 'appStateChange'); adds++; listener = callback;
      return { remove: async () => { removes++; } };
    },
    getState: () => { reads++; return snapshot.promise; }
  } as unknown as AppPlugin;
  const r = rig(nativeApp);
  installAppLifecycle(r.game, nativeApp);
  await settle();
  assert.equal(adds, 1, 'one native listener per game');
  assert.equal(reads, 1);
  listener({ isActive: false }); // Control Center: document is still visible.
  assert.equal(domDocument.hidden, false);
  assert.equal(isAppActive(r.game), false);
  assert.equal(r.get().paused, true);
  assert.equal(audioActive, false);
  assert.equal(r.get().resets, 1);
  assert.equal(r.keyboard.queue.length, 0, 'no stale queued Resume key');
  snapshot.resolve({ isActive: true });
  await settle();
  assert.equal(isAppActive(r.game), false, 'late boot snapshot cannot undo interruption');
  r.canvas.dispatchEvent(new Event('pointerdown'));
  domWindow.dispatchEvent(new Event('keydown'));
  assert.equal(gestures, 0, 'no audio unlock from background gestures');
  // A DOM focus event alone cannot override native inactivity.
  r.events.emit('focus');
  assert.equal(isAppActive(r.game), false);
  listener({ isActive: true });
  assert.equal(isAppActive(r.game), true);
  assert.equal(audioActive, true);
  assert.equal(r.get().paused, true, 'foreground never auto-resumes');
  assert.equal(gestures, 0, 'foreground never auto-unlocks audio');
  r.canvas.dispatchEvent(new Event('pointerdown'));
  assert.equal(gestures, 1);
  const repeat = new Event('keydown');
  Object.defineProperty(repeat, 'repeat', { value: true });
  domWindow.dispatchEvent(repeat);
  assert.equal(gestures, 1, 'an old held key repeat cannot recover audio');
  listener({ isActive: false }); listener({ isActive: false });
  assert.equal(r.get().inactive, 2, 'duplicate native events cannot manufacture state transitions');
  assert.ok(r.get().cancels >= 3, 'a second interruption cancels even already-paused menu presses');
  r.events.emit('destroy');
  await settle();
  assert.equal(removes, 1, 'remove only our native subscription');
  const previous = r.get();
  listener({ isActive: true });
  r.events.emit('blur');
  domWindow.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(r.get(), previous, 'destroy removes DOM/native callbacks');
  r.canvas.dispatchEvent(new Event('pointerdown'));
  assert.equal(gestures, 1);

  const web = rig(null);
  assert.equal(audioActive, true, 'a new game can unlock audio again after teardown');
  web.events.emit('blur');
  assert.equal(isAppActive(web.game), false);
  web.events.emit('focus');
  assert.equal(isAppActive(web.game), true);
  domWindow.dispatchEvent(new Event('pagehide'));
  web.events.emit('focus');
  assert.equal(isAppActive(web.game), false, 'focus cannot override a hidden page');
  domWindow.dispatchEvent(new Event('pageshow'));
  assert.equal(isAppActive(web.game), true);
  assert.equal(web.get().paused, true);
  domDocument.hidden = true;
  domDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(isAppActive(web.game), false);
  domDocument.hidden = false;
  domDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(isAppActive(web.game), true);
  web.events.emit('destroy');

  // A listener promise may resolve after Phaser has already been destroyed.
  const pending = deferred<PluginListenerHandle>();
  let lateRemoves = 0, lateReads = 0;
  const late = rig({
    addListener: () => pending.promise,
    getState: async () => { lateReads++; return { isActive: true }; }
  } as unknown as AppPlugin);
  late.events.emit('destroy');
  pending.resolve({ remove: async () => { lateRemoves++; } });
  await settle();
  assert.equal(lateRemoves, 1);
  assert.equal(lateReads, 0);

  const rejected = rig({
    addListener: () => Promise.reject(new Error('Plugin unavailable')),
    getState: async () => ({ isActive: true })
  } as unknown as AppPlugin);
  await settle();
  domWindow.dispatchEvent(new Event('pagehide'));
  assert.equal(rejected.get().paused, true, 'browser fallback survives unavailable native plugin');
  rejected.events.emit('destroy');
  const throws = rig({
    addListener: () => { throw new Error('Synchronous plugin error'); },
    getState: async () => ({ isActive: true })
  } as unknown as AppPlugin);
  await settle();
  domWindow.dispatchEvent(new Event('pagehide'));
  assert.equal(throws.get().paused, true, 'sync plugin failure also retains browser fallback');
  throws.events.emit('destroy');
  console.log('PASS mobile lifecycle: native inactive while DOM visible, stale snapshots, explicit resume, cancelled pointers/keys, background audio gating, web/bfcache fallback, idempotence, teardown and unavailable plugin');
} finally {
  audio.setActive = originalActive; audio.unlock = originalUnlock;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
}
