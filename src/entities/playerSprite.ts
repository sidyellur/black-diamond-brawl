import Phaser from 'phaser';
import { PixelCanvas, registerTexture } from '../render/pixel';
import {
  drawRider,
  PLAYER_RIDER_PALETTE,
  RIDER_FRAME_SIZE,
  RIVAL_RIDER_PALETTES,
  RiderPose
} from './riderArt';

export const PLAYER_TEXTURE_KEY = 'player-sheet';
export const PLAYER_FRAME_SIZE = RIDER_FRAME_SIZE;

/**
 * Frame layout of the rider sprite sheet: five frames in a single row, left to
 * right — lean-left, center, lean-right, jump, tumble. AI rivals reuse this
 * exact layout with a different palette, so any edit here must stay
 * additive/positional.
 *
 * The art itself lives in `riderArt.ts`; this module only bakes it into Phaser
 * textures. Keeping generation separate from registration is what lets the
 * sprite lab render the same buffers without booting a race.
 */
export const PLAYER_FRAMES = {
  LEAN_LEFT: 'lean-left',
  CENTER: 'center',
  LEAN_RIGHT: 'lean-right',
  JUMP: 'jump',
  TUMBLE: 'tumble'
} as const;

const FRAME_ORDER: RiderPose[] = ['lean-left', 'center', 'lean-right', 'jump', 'tumble'];

/** Builds the player's sheet. Called once from BootScene; no-ops if present. */
export function generatePlayerSpriteSheet(scene: Phaser.Scene): void {
  generateRiderSheet(scene, PLAYER_TEXTURE_KEY, PLAYER_RIDER_PALETTE);
}

export const AI_RIDER_TEXTURE_KEYS = [
  'ai-rider-sheet-0',
  'ai-rider-sheet-1',
  'ai-rider-sheet-2',
  'ai-rider-sheet-3'
] as const;

/** Builds all four rival sheets. Rivals differ by suit *and* board colour —
 *  suit hue alone is not enough to tell them apart once they are small on
 *  screen, or once colour vision is taken out of the equation. */
export function generateAIRiderSpriteSheets(scene: Phaser.Scene): void {
  AI_RIDER_TEXTURE_KEYS.forEach((key, i) =>
    generateRiderSheet(scene, key, RIVAL_RIDER_PALETTES[i])
  );
}

function generateRiderSheet(
  scene: Phaser.Scene,
  textureKey: string,
  palette: { suit: number; board: number }
): void {
  if (scene.textures.exists(textureKey)) {
    return;
  }

  const size = RIDER_FRAME_SIZE;
  const sheet = new PixelCanvas(size * FRAME_ORDER.length, size);
  FRAME_ORDER.forEach((pose, i) => {
    sheet.blit(drawRider(pose, palette), i * size, 0);
  });

  registerTexture(scene, textureKey, sheet);

  const texture = scene.textures.get(textureKey);
  FRAME_ORDER.forEach((pose, i) => texture.add(pose, 0, i * size, 0, size, size));
}
