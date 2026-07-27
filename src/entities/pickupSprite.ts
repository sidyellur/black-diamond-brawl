import Phaser from 'phaser';
import { registerTexture } from '../render/pixel';
import { drawPickup, PICKUP_ART_SIZE } from './pickupArt';

export const PICKUP_TEXTURE_KEY = 'pickup-sheet';
export const PICKUP_FRAME_SIZE = PICKUP_ART_SIZE;
export const PICKUP_FRAME = 'ski-pole';

/**
 * Bakes the ski-pole pickup texture. The art lives in `pickupArt.ts`; this
 * only registers it. Called once from BootScene; no-ops if it already exists.
 */
export function generatePickupSpriteSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(PICKUP_TEXTURE_KEY)) {
    return;
  }

  const cv = drawPickup();
  registerTexture(scene, PICKUP_TEXTURE_KEY, cv);

  const texture = scene.textures.get(PICKUP_TEXTURE_KEY);
  texture.add(PICKUP_FRAME, 0, 0, 0, cv.w, cv.h);
}
