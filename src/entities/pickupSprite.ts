import Phaser from 'phaser';
import { PixelCanvas, registerTexture } from '../render/pixel';
import { drawPickupKind, PICKUP_ART_SIZE } from './pickupArt';
import { PICKUP_KIND_LIST, PickupKind } from './pickup';

export const PICKUP_TEXTURE_KEY = 'pickup-sheet';
export const PICKUP_FRAME_SIZE = PICKUP_ART_SIZE;
/** Frame name per pickup kind; the pole keeps its original name. */
export const PICKUP_FRAMES: Record<PickupKind, string> = {
  pole: 'ski-pole', shield: 'shield', wax: 'speed-wax', snowball: 'snowball'
};

/**
 * Bakes the pickup texture: one row of frames, one per kind. The art lives in
 * `pickupArt.ts`; this only registers it. Called once from BootScene; no-ops
 * if it already exists.
 */
export function generatePickupSpriteSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(PICKUP_TEXTURE_KEY)) {
    return;
  }

  const sheet = new PixelCanvas(PICKUP_FRAME_SIZE * PICKUP_KIND_LIST.length, PICKUP_FRAME_SIZE);
  PICKUP_KIND_LIST.forEach((kind, index) => sheet.blit(drawPickupKind(kind), index * PICKUP_FRAME_SIZE, 0));
  registerTexture(scene, PICKUP_TEXTURE_KEY, sheet);

  const texture = scene.textures.get(PICKUP_TEXTURE_KEY);
  PICKUP_KIND_LIST.forEach((kind, index) => {
    texture.add(PICKUP_FRAMES[kind], 0, index * PICKUP_FRAME_SIZE, 0, PICKUP_FRAME_SIZE, PICKUP_FRAME_SIZE);
  });
}
