import type Phaser from 'phaser';
import { Player } from './player';
import { oncePerKeyEvent } from '../input/keyboardEvents';

export type PlayerAction = 'left' | 'right' | 'jump' | 'attack';
/** Concise alias for UI bindings. */
export type InputAction = PlayerAction;

/** Deliberate, predictable steering; independent of the OS keyboard repeat. */
export const STEER_REPEAT_DELAY_MS = 210;
export const STEER_REPEAT_MS = 170;
/** A late press can survive a landing, but never a whole jump or tumble. */
export const ACTION_BUFFER_MS = 160;

export interface PlayerInput {
  /** Call once per active simulation frame, before polling attack and updating
   * the player. Skip this during hit-stop; events only record intent. */
  update(deltaMs: number): void;
  attackJustPressed(): boolean;
  /** Disabling clears pending actions and requires held controls to be released. */
  setEnabled(enabled: boolean): void;
  reset(): void;
  /** Shared entry point for keyboard and multi-touch. Use a distinct source for
   * each physical key/pointer so releasing one doesn't release another. */
  setAction(action: PlayerAction, pressed: boolean, source?: string): void;
  destroy(): void;
}

/** DOM-free input state machine. Events record edges; only update() may move
 * the rider. Kept independently testable from Phaser and its browser globals. */
export class PlayerInputController implements PlayerInput {
  private enabled = true;
  private focused = true;
  private destroyed = false;
  private sources = new Map<string, PlayerAction>();
  private blockedSources = new Set<string>();
  private lanePress: { direction: -1 | 1; at: number } | null = null;
  private jumpPressedAt: number | null = null;
  private attackPressedAt: number | null = null;
  private attackReady = false;
  private repeatDirection: -1 | 0 | 1 = 0;
  private repeatInMs = STEER_REPEAT_DELAY_MS;

  constructor(
    private readonly player: Player,
    private readonly onJump: () => void = () => player.requestJump(),
    private readonly now: () => number = () => performance.now()
  ) {}

  setAction(action: PlayerAction, pressed: boolean, source: string = action): void {
    if (this.destroyed) return;
    if (!pressed) {
      this.sources.delete(source);
      this.blockedSources.delete(source);
      return;
    }
    // Repeated keydown events cannot manufacture new actions.
    if (this.sources.has(source)) return;
    const wasDown = this.isDown(action);
    this.sources.set(source, action);
    if (!this.enabled || !this.focused) {
      this.blockedSources.add(source);
      return;
    }
    if (wasDown || this.blockedSources.has(source)) return;
    const at = this.now();
    if (action === 'left' || action === 'right') {
      this.lanePress = { direction: action === 'left' ? -1 : 1, at };
    } else if (action === 'jump') {
      this.jumpPressedAt = at;
    } else {
      this.attackPressedAt = at;
    }
  }

  update(deltaMs: number): void {
    this.attackReady = false;
    if (!this.enabled || !this.focused || this.destroyed || this.player.wipedOut) return;
    const now = this.now();
    const delta = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
    const left = this.isDown('left');
    const right = this.isDown('right');
    const direction = left === right ? 0 : left ? -1 : 1;
    let shifted = false;

    if (this.lanePress && now - this.lanePress.at <= ACTION_BUFFER_MS && !(left && right)) {
      this.player.requestLaneShift(this.lanePress.direction);
      shifted = true;
    }
    this.lanePress = null;

    if (direction === 0 || direction !== this.repeatDirection || shifted) {
      // Releasing an opposing key leaves a clear, current steering intent.
      if (direction !== 0 && direction !== this.repeatDirection && !shifted) {
        this.player.requestLaneShift(direction);
      }
      this.repeatDirection = direction;
      this.repeatInMs = STEER_REPEAT_DELAY_MS;
    } else {
      this.repeatInMs -= delta;
      if (this.repeatInMs <= 0) {
        // At most one repeat per frame: a hitch must never fling the rider
        // across several lanes or build an invisible queue of commands.
        this.player.requestLaneShift(direction);
        this.repeatInMs = STEER_REPEAT_MS;
      }
    }

    if (this.jumpPressedAt !== null) {
      if (now - this.jumpPressedAt > ACTION_BUFFER_MS) {
        this.jumpPressedAt = null;
      } else if (this.player.canJump) {
        this.jumpPressedAt = null;
        // Decide mogul/trick launch at execution, not at the buffered press.
        this.onJump();
      }
    }
    if (this.attackPressedAt !== null) {
      this.attackReady = now - this.attackPressedAt <= ACTION_BUFFER_MS;
      this.attackPressedAt = null;
    }
  }

  attackJustPressed(): boolean {
    const pressed = this.enabled && this.focused && !this.destroyed && this.attackReady;
    this.attackReady = false;
    return pressed;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled || this.destroyed) return;
    this.enabled = enabled;
    this.reset();
  }

  /** Focus is independent of scene enablement: refocusing never unpauses. */
  setFocused(focused: boolean): void {
    if (this.focused === focused || this.destroyed) return;
    this.focused = focused;
    this.reset();
    if (!focused) {
      // Browsers can lose release events outside their window. Forget physical
      // sources on blur; a held keyboard can emit only ignored OS repeats.
      this.sources.clear();
      this.blockedSources.clear();
    }
  }

  reset(): void {
    // Holding a key across pause/start cannot become a fresh command on resume.
    this.sources.forEach((_action, source) => this.blockedSources.add(source));
    this.lanePress = null;
    this.jumpPressedAt = null;
    this.attackPressedAt = null;
    this.attackReady = false;
    this.repeatDirection = 0;
    this.repeatInMs = STEER_REPEAT_DELAY_MS;
    this.player.clearInputBuffer();
  }

  destroy(): void {
    this.reset();
    this.sources.clear();
    this.blockedSources.clear();
    this.destroyed = true;
  }

  private isDown(action: PlayerAction): boolean {
    for (const [source, heldAction] of this.sources) {
      if (heldAction === action && !this.blockedSources.has(source)) return true;
    }
    return false;
  }
}

const KEY_ACTIONS: Readonly<Record<string, PlayerAction>> = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'jump', ArrowUp: 'jump', KeyW: 'jump', KeyF: 'attack', KeyK: 'attack'
};
const KEY_NAMES = ['LEFT', 'A', 'RIGHT', 'D', 'SPACE', 'UP', 'W', 'F', 'K'];

export function bindPlayerInput(
  scene: Phaser.Scene,
  player: Player,
  onJump?: () => void
): PlayerInput {
  const controller = new PlayerInputController(player, onJump);
  const keyboard = scene.input.keyboard;
  const keys = keyboard ? KEY_NAMES.map((code) => keyboard.addKey(code, true, false)) : [];
  const down = oncePerKeyEvent((event): void => {
    const action = KEY_ACTIONS[event.code];
    if (action && !event.repeat) controller.setAction(action, true, event.code);
  });
  const up = oncePerKeyEvent((event): void => {
    const action = KEY_ACTIONS[event.code];
    if (action) controller.setAction(action, false, event.code);
  });
  const suspend = (): void => controller.setEnabled(false);
  const visibility = (): void => controller.setFocused(!document.hidden);
  const focus = (): void => controller.setFocused(true);
  // Refocus cannot re-enable a paused/countdown race; the scene owns that.
  const blur = (): void => controller.setFocused(false);

  keyboard?.on('keydown', down);
  keyboard?.on('keyup', up);
  scene.events.on('pause', suspend);
  scene.events.on('sleep', suspend);
  scene.game.events.on('blur', blur);
  scene.game.events.on('focus', focus);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  // A release must be observed even while a Phaser scene is paused, when its
  // keyboard plugin stops processing events. Otherwise one key stays stuck.
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    window.addEventListener('keyup', up);
  }

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    controller.destroy();
    keyboard?.off('keydown', down);
    keyboard?.off('keyup', up);
    // Only the keys registered by this binding are owned by it.
    keys.forEach((key) => keyboard?.removeKey(key, true, true));
    // Phaser may have destroyed the keys earlier in the shutdown event.
    // Remove their global captures explicitly as well as their listeners.
    keyboard?.removeCapture(KEY_NAMES);
    scene.events.off('pause', suspend);
    scene.events.off('sleep', suspend);
    scene.events.off('shutdown', destroy);
    scene.game.events.off('blur', blur);
    scene.game.events.off('focus', focus);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      window.removeEventListener('keyup', up);
    }
  };
  scene.events.once('shutdown', destroy);

  return {
    update: (delta) => controller.update(delta),
    attackJustPressed: () => controller.attackJustPressed(),
    setEnabled: (enabled) => controller.setEnabled(enabled),
    reset: () => controller.reset(),
    setAction: (action, pressed, source) => controller.setAction(action, pressed, source),
    destroy
  };
}
