import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { installViewportFit } from '../src/input/viewportFit';

let width = 390, height = 844, left = 0, top = 0;
let refreshes = 0, observers = 0, disconnected = 0;
let observe: () => void = () => {};
let mutation: () => void = () => {};
const windowEvents = new EventTarget();
const visualEvents = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousMutation = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
Object.assign(windowEvents, { visualViewport: visualEvents });
Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents });
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
  constructor(callback: () => void) { observers++; observe = callback; }
  observe() {}
  disconnect() { disconnected++; }
} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
  constructor(callback: () => void) { mutation = callback; }
  observe() {}
  disconnect() {}
} });
const parentSize = { width: 0, height: 0 };
let display = { width: 0, height: 0 };
const order: string[] = [];
const events = new EventEmitter();
const game = { events, scale: {
  parent: { getBoundingClientRect: () => ({ width, height, left, top }) },
  getParentBounds: () => { order.push('bounds'); Object.assign(parentSize, { width, height }); },
  refresh: () => {
    order.push('fit'); refreshes++;
    const factor = Math.min(parentSize.width / 960, parentSize.height / 540);
    display = { width: 960 * factor, height: 540 * factor };
  }
} } as unknown as Phaser.Game;
try {
  installViewportFit(game); installViewportFit(game);
  assert.equal(observers, 1); assert.equal(events.listenerCount('destroy'), 1);
  assert.deepEqual(display, { width: 390, height: 219.375 });
  for (const dimensions of [[844, 390], [390, 844], [1440, 900], [844, 390]]) {
    [width, height] = dimensions;
    // Reproduce the framework race: its cache already contains new parent
    // bounds, while the display still has the previous orientation's fit.
    Object.assign(parentSize, { width, height });
    order.length = 0; observe();
    assert.deepEqual(order, ['bounds', 'fit']);
    const factor = Math.min(width / 960, height / 540);
    assert.deepEqual(display, { width: 960 * factor, height: 540 * factor });
  }
  const count = refreshes; observe(); windowEvents.dispatchEvent(new Event('resize'));
  assert.equal(refreshes, count, 'unchanged dimensions do not rebuild the scale');
  left = 47; mutation();
  assert.equal(refreshes, count + 1, 'position-only safe-area changes refresh pointer coordinates');
  left = 0; top = 21; windowEvents.dispatchEvent(new Event('orientationchange'));
  assert.equal(refreshes, count + 2, 'same-size landscape orientation updates origin');
  left = 47; windowEvents.dispatchEvent(new Event('touchstart'));
  assert.equal(refreshes, count + 3, 'capture refreshes an origin-only change before touch mapping');
  width = 800; visualEvents.dispatchEvent(new Event('resize'));
  assert.equal(refreshes, count + 4);
  width = 0; height = 0; observe(); assert.equal(refreshes, count + 4);
  events.emit('destroy'); assert.equal(disconnected, 1);
  width = 960; height = 540; windowEvents.dispatchEvent(new Event('resize')); visualEvents.dispatchEvent(new Event('resize'));
  assert.equal(refreshes, count + 4, 'destroy removes viewport listeners');
} finally {
  if (previousMutation) Object.defineProperty(globalThis, 'MutationObserver', previousMutation); else Reflect.deleteProperty(globalThis, 'MutationObserver');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousObserver) Object.defineProperty(globalThis, 'ResizeObserver', previousObserver); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
}
console.log('PASS viewport FIT: bounds before fit, repeated rotations, idempotent setup, no zero-size work, same-size origin changes before touch and destroy cleanup');
