import type Phaser from 'phaser';

const boundGames = new WeakSet<Phaser.Game>();

/** Sample the current mount before asking Phaser to FIT it. In Phaser 3.90 an
 * orientation event can refresh using old parent bounds and only then cache
 * the new bounds, leaving its later dirty check with nothing to refresh.
 */
export function installViewportFit(game: Phaser.Game): void {
  const parent = game.scale.parent;
  if (!parent || boundGames.has(game)) return;
  boundGames.add(game);
  let width = -1;
  let height = -1;
  let left = NaN;
  let top = NaN;
  const refresh = (): void => {
    const bounds = parent.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || (bounds.width === width && bounds.height === height && bounds.left === left && bounds.top === top)) return;
    width = bounds.width; height = bounds.height; left = bounds.left; top = bounds.top;
    game.scale.getParentBounds();
    game.scale.refresh();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
  observer?.observe(parent);
  // Opposite landscape notches can move the mount without resizing it.
  // ResizeObserver only observes size; explicit CSS safe-area overrides and
  // host layout mutations still need fresh pointer coordinate bounds.
  const mutations = typeof MutationObserver === 'undefined' || typeof document === 'undefined'
    ? null : new MutationObserver(refresh);
  mutations?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  mutations?.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', refresh);
  window.addEventListener('orientationchange', refresh);
  // CSS env() can settle after an orientation event without a size change.
  // Refresh at capture phase before Phaser maps a new gesture, avoiding a
  // layout read on every animation frame.
  for (const event of ['pointerdown', 'touchstart', 'mousedown']) window.addEventListener(event, refresh, { capture: true, passive: true });
  window.visualViewport?.addEventListener('resize', refresh);
  refresh();
  game.events.once('destroy', () => {
    observer?.disconnect();
    mutations?.disconnect();
    window.removeEventListener('resize', refresh);
    window.removeEventListener('orientationchange', refresh);
    for (const event of ['pointerdown', 'touchstart', 'mousedown']) window.removeEventListener(event, refresh, true);
    window.visualViewport?.removeEventListener('resize', refresh);
    boundGames.delete(game);
  });
}
