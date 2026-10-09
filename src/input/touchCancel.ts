import type Phaser from 'phaser';

const guarded = new WeakSet<Phaser.Input.Touch.TouchManager>();

/** Phaser 3.90 guards preventDefault with event.cancelable for every touch
 * path except touchcancel. Keep its normal dispatch and capture behavior,
 * but don't ask the browser to cancel an explicitly non-cancelable event.
 * Disabling capture globally would permit compatibility mouse double-taps.
 */
export function guardTouchCancel(touch: Phaser.Input.Touch.TouchManager | null): void {
  if (!touch?.target || guarded.has(touch)) return;
  const target: EventTarget = touch.target;
  const original = touch.onTouchCancel as (event: TouchEvent) => void;
  const handler = (event: TouchEvent): void => {
    const capture = touch.capture;
    if (!event.cancelable) touch.capture = false;
    try { original(event); }
    finally { touch.capture = capture; }
  };
  target.removeEventListener('touchcancel', original as EventListener);
  touch.onTouchCancel = handler;
  target.addEventListener('touchcancel', handler as EventListener, { passive: !touch.capture });
  // TouchManager.stopListeners removes its current onTouchCancel reference,
  // so game destruction also removes this replacement without another hook.
  guarded.add(touch);
}
