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
  const refresh = (): void => {
    const bounds = parent.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || (bounds.width === width && bounds.height === height)) return;
    width = bounds.width; height = bounds.height;
    game.scale.getParentBounds();
    game.scale.refresh();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
  observer?.observe(parent);
  window.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('resize', refresh);
  refresh();
  game.events.once('destroy', () => {
    observer?.disconnect();
    window.removeEventListener('resize', refresh);
    window.visualViewport?.removeEventListener('resize', refresh);
    boundGames.delete(game);
  });
}
