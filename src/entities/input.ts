import Phaser from 'phaser';
import { Player } from './player';

/**
 * Wires the two control actions (lane-shift, jump — design-spec §4.3) to
 * their keys. Deliberately not a generic input-mapping system: this project
 * has exactly two actions, and Phaser's `keydown-*` events already give us
 * one-fire-per-press for free (no manual "just pressed" debouncing needed).
 */
export function bindPlayerInput(scene: Phaser.Scene, player: Player, onJump?: () => void): void {
  const keyboard = scene.input.keyboard;
  if (!keyboard) {
    return;
  }

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
