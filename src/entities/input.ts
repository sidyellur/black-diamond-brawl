import Phaser from 'phaser';
import { Player } from './player';

/**
 * Wires the two control actions (lane-shift, jump — design-spec §4.3) to
 * their keys. Deliberately not a generic input-mapping system: this project
 * has exactly two actions, and Phaser's `keydown-*` events already give us
 * one-fire-per-press for free (no manual "just pressed" debouncing needed).
 */
export function bindPlayerInput(scene: Phaser.Scene, player: Player): void {
  const keyboard = scene.input.keyboard;
  if (!keyboard) {
    return;
  }

  keyboard.on('keydown-LEFT', () => player.requestLaneShift(-1));
  keyboard.on('keydown-A', () => player.requestLaneShift(-1));
  keyboard.on('keydown-RIGHT', () => player.requestLaneShift(1));
  keyboard.on('keydown-D', () => player.requestLaneShift(1));

  keyboard.on('keydown-SPACE', () => player.requestJump());
  keyboard.on('keydown-UP', () => player.requestJump());
}
