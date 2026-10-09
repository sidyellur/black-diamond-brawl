import { App, type AppPlugin } from '@capacitor/app';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import type Phaser from 'phaser';
import { getRaceAudio } from '../audio/RaceAudio';
import { flushStorage } from '../platform/storage';

export const APP_INACTIVE = 'bdb:inactive';
export const APP_ACTIVE = 'bdb:active';
export const CANCEL_INPUT = 'bdb:cancel-input';

const activeGames = new WeakMap<Phaser.Game, boolean>();

/** Foreground permits a fresh gesture; it never resumes a paused race. */
export function isAppActive(game: Phaser.Game): boolean {
  return activeGames.get(game) ?? (typeof document === 'undefined' || !document.hidden);
}

/** One lifecycle bridge for both Safari and the native WebView. Capacitor's
 * willResignActive arrives for Control Center/calls even if the DOM stays
 * visible. Browser visibility/pagehide remain useful fallbacks and support
 * the back-forward cache. Only remove the native listener that we own.
 */
export function installAppLifecycle(
  game: Phaser.Game,
  nativeApp: Pick<AppPlugin, 'addListener' | 'getState'> | null = Capacitor.isNativePlatform() ? App : null
): void {
  if (activeGames.has(game)) return;
  let disposed = false;
  let nativeActive = true;
  let windowFocused = true;
  let pageVisible = true;
  let nativeRevision = 0;
  let nativeListener: PluginListenerHandle | undefined;
  const audio = getRaceAudio();
  audio.setActive(true);
  activeGames.set(game, true);

  const update = (): void => {
    if (disposed) return;
    const active = nativeActive && windowFocused && pageVisible && !document.hidden;
    const changed = activeGames.get(game) !== active;
    activeGames.set(game, active);
    if (!active) {
      // iOS can drop touchend/keyup while opening system UI. Reset Phaser's
      // pointer slots as well as gameplay state so all four fingers can be
      // used again, with no stale menu click on a later release.
      game.events.emit(CANCEL_INPUT);
      game.input.pointers.forEach(pointer => pointer.reset());
      // Phaser 3.90 exposes its pending DOM queue at runtime but omits this
      // internal property from the typings. Drop pre-interruption keydowns.
      const keyboard = game.input.keyboard as (Phaser.Input.Keyboard.KeyboardManager & { queue: KeyboardEvent[] }) | null;
      if (keyboard) keyboard.queue.length = 0;
      audio.setActive(false);
      void flushStorage();
    } else if (changed) {
      audio.setActive(true);
    }
    if (changed) game.events.emit(active ? APP_ACTIVE : APP_INACTIVE);
  };
  const blur = (): void => { windowFocused = false; update(); };
  const focus = (): void => { windowFocused = true; update(); };
  const hidePage = (): void => { pageVisible = false; update(); };
  const showPage = (): void => { pageVisible = true; windowFocused = true; update(); };
  const visibility = (): void => {
    // Safari may restore a document without a separate window focus event.
    if (!document.hidden) windowFocused = true;
    update();
  };
  const gesture = (event: Event): void => {
    if (event.type === 'keydown' && (event as KeyboardEvent).repeat) return;
    if (isAppActive(game)) audio.unlock();
  };
  game.events.on('blur', blur);
  game.events.on('focus', focus);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', hidePage);
  window.addEventListener('pageshow', showPage);
  // Raw events run inside the user activation, before Phaser queues keys.
  // They also recover audio on result/menu screens after an interruption.
  game.canvas.addEventListener('pointerdown', gesture);
  window.addEventListener('keydown', gesture);
  update();

  if (nativeApp) {
    const receiveState = ({ isActive }: { isActive: boolean }): void => {
      if (disposed) return;
      nativeRevision++;
      nativeActive = isActive;
      // Native foreground is authoritative for WebView focus, which may
      // not deliver the corresponding browser focus event on iOS.
      if (isActive) windowFocused = true;
      update();
    };
    void (async () => {
      const listener = await nativeApp.addListener('appStateChange', receiveState);
      if (disposed) { await listener.remove(); return; }
      nativeListener = listener;
      const revision = nativeRevision;
      const state = await nativeApp.getState();
      // A late boot snapshot must not override a newer background event.
      if (!disposed && revision === nativeRevision) receiveState(state);
    })().catch(() => { /* Browser lifecycle remains a safe fallback. */ });
  }

  game.events.once('destroy', () => {
    disposed = true;
    activeGames.delete(game);
    game.events.off('blur', blur);
    game.events.off('focus', focus);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', hidePage);
    window.removeEventListener('pageshow', showPage);
    game.canvas.removeEventListener('pointerdown', gesture);
    window.removeEventListener('keydown', gesture);
    void nativeListener?.remove().catch(() => {});
    audio.setActive(false);
  });
}
