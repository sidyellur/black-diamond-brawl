import Phaser from 'phaser';
import { Player } from './player';

/**
 * Wires the two control actions (lane-shift, jump — design-spec §4.3) to
 * their keys.
 *
 * **`keydown-*` does NOT give one-fire-per-press for free.** An earlier
 * version of this file claimed it did. Phaser suppresses OS auto-repeat only
 * when a `Key` object exists for that code — `KeyboardPlugin` checks
 * `repeat = key.isDown` and skips the emit, but that branch is guarded on
 * `key` being non-null, and `key` only exists once someone has called
 * `addKey()`. Without it, a held key emits `keydown-*` at the operating
 * system's repeat rate (~30 Hz).
 *
 * That was survivable for the two actions bound here — a repeated lane-shift
 * is absorbed by the one-deep input buffer, and a repeated jump no-ops while
 * already airborne — which is why it went unnoticed. It stops being
 * survivable for any action with a per-press cost, so the keys are registered
 * properly here rather than left as a trap for whoever adds the next one.
 *
 * `addKey(code, enableCapture, emitOnRepeat)` — capture the key so the
 * browser does not also act on it (arrows scroll, space scrolls), and leave
 * `emitOnRepeat` false so a held key fires exactly once.
 */
export function bindPlayerInput(scene: Phaser.Scene, player: Player, onJump?: () => void): void {
  const keyboard = scene.input.keyboard;
  if (!keyboard) {
    return;
  }

  const KEYS = Phaser.Input.Keyboard.KeyCodes;
  // Registering a Key for every bound code is what activates Phaser's
  // auto-repeat suppression for the matching `keydown-*` events below.
  [KEYS.LEFT, KEYS.A, KEYS.RIGHT, KEYS.D, KEYS.SPACE, KEYS.UP].forEach((code) =>
    keyboard.addKey(code, true, false)
  );

  keyboard.on('keydown-LEFT', () => player.requestLaneShift(-1));
  keyboard.on('keydown-A', () => player.requestLaneShift(-1));
  keyboard.on('keydown-RIGHT', () => player.requestLaneShift(1));
  keyboard.on('keydown-D', () => player.requestLaneShift(1));

  // Jump routes through `onJump` when supplied so the scene can upgrade a press
  // near a mogul into an extended launch (§4.3); otherwise a plain normal jump.
  const jump = onJump ?? (() => player.requestJump());
  keyboard.on('keydown-SPACE', jump);
  keyboard.on('keydown-UP', jump);
}
