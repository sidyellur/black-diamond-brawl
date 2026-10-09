import assert from 'node:assert/strict';
import type Phaser from 'phaser';
import { guardTouchCancel } from '../src/input/touchCancel';

const listeners = new Map<string, EventListener>();
let dispatches = 0;
let invalidPrevents = 0;
let validPrevents = 0;
let additions = 0;
const target = {
  addEventListener: (name: string, fn: EventListener) => { listeners.set(name, fn); additions++; },
  removeEventListener: (name: string, fn: EventListener) => { if (listeners.get(name) === fn) listeners.delete(name); }
};
const manager = { target, capture: true, onTouchCancel: (_event: TouchEvent) => {} };
manager.onTouchCancel = (event) => {
  dispatches++;
  if (manager.capture) event.preventDefault(); // Phaser 3.90's original path.
};
listeners.set('touchcancel', manager.onTouchCancel as EventListener);
guardTouchCancel(manager as unknown as Phaser.Input.Touch.TouchManager);
guardTouchCancel(manager as unknown as Phaser.Input.Touch.TouchManager);
assert.equal(additions, 1, 'install once even if boot is revisited');
for (const cancelable of [false, true]) {
  const event = { cancelable, preventDefault: () => { if (cancelable) validPrevents++; else invalidPrevents++; } } as TouchEvent;
  listeners.get('touchcancel')!(event);
  assert.equal(manager.capture, true, 'normal touch capture must be restored');
}
assert.equal(dispatches, 2, 'both cancellations still reach Phaser');
assert.equal(invalidPrevents, 0);
assert.equal(validPrevents, 1);
manager.capture = false;
listeners.get('touchcancel')!({ cancelable: false } as TouchEvent);
assert.equal(manager.capture, false, 'respect an intentionally uncaptured configuration');
target.removeEventListener('touchcancel', manager.onTouchCancel as EventListener);
assert.equal(listeners.size, 0, 'framework stopListeners can remove replacement');
console.log('PASS touchcancel guard: dispatch retained, only cancelable events prevented, capture restored, idempotent and removable');
