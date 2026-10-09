import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { installViewportFit } from '../src/input/viewportFit';

let width = 390, height = 844;
let refreshes = 0, observers = 0, disconnected = 0;
let observe: () => void = () => {};
const windowEvents = new EventTarget();
const visualEvents = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
Object.assign(windowEvents, { visualViewport: visualEvents });
Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents });
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
  constructor(callback: () => void) { observers++; observe = callback; }
  observe() {}
  disconnect() { disconnected++; }
} });
const parentSize = { width: 0, height: 0 };
let display = { width: 0, height: 0 };
const order: string[] = [];
const events = new EventEmitter();
const game = { events, scale: {
  parent: { getBoundingClientRect: () => ({ width, height }) },
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
  width = 800; visualEvents.dispatchEvent(new Event('resize'));
  assert.equal(refreshes, count + 1);
  width = 0; height = 0; observe(); assert.equal(refreshes, count + 1);
  events.emit('destroy'); assert.equal(disconnected, 1);
  width = 960; height = 540; windowEvents.dispatchEvent(new Event('resize')); visualEvents.dispatchEvent(new Event('resize'));
  assert.equal(refreshes, count + 1, 'destroy removes viewport listeners');
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousObserver) Object.defineProperty(globalThis, 'ResizeObserver', previousObserver); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
}
console.log('PASS viewport FIT: bounds before fit, repeated rotations, idempotent setup, no zero-size work, stable same-size events and destroy cleanup');
