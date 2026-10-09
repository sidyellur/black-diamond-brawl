/** Phaser 3 can revisit its DOM event queue several times before postUpdate.
 * Its last-event guard does not catch an older down/up pair once a later key
 * arrives, so toggles and released controls can fire again on a slow frame.
 * Track event identity per binding, not just key code/time. Weak references
 * do not retain old browser events, and a fresh physical press still works.
 */
export function oncePerKeyEvent(
  callback: (event: KeyboardEvent) => void
): (event: KeyboardEvent) => void {
  const seen = new WeakSet<KeyboardEvent>();
  return (event): void => {
    if (seen.has(event)) return;
    seen.add(event);
    callback(event);
  };
}
