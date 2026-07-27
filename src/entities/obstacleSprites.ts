import Phaser from 'phaser';
import { PixelCanvas, registerTexture } from '../render/pixel';
import { ObstacleKind } from './obstacle';
import { drawObstacle, OBSTACLE_ART_SIZE } from './obstacleArt';

export const OBSTACLE_TEXTURE_KEY = 'obstacle-sheet';
export const OBSTACLE_FRAME_SIZE = OBSTACLE_ART_SIZE;

/** Frame names, one per obstacle kind — `setFrame(OBSTACLE_FRAMES[kind])`. */
export const OBSTACLE_FRAMES: Record<ObstacleKind, string> = {
  tree: 'tree',
  rock: 'rock',
  mogul: 'mogul'
};

const FRAME_ORDER: ObstacleKind[] = ['tree', 'rock', 'mogul'];

/**
 * Bakes the obstacle sheet. The art lives in `obstacleArt.ts`; this only
 * registers it as a Phaser texture with named sub-frames. Called once from
 * BootScene; no-ops if the texture already exists.
 */
export function generateObstacleSpriteSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(OBSTACLE_TEXTURE_KEY)) {
    return;
  }

  const size = OBSTACLE_ART_SIZE;
  const sheet = new PixelCanvas(size * FRAME_ORDER.length, size);
  FRAME_ORDER.forEach((kind, i) => sheet.blit(drawObstacle(kind), i * size, 0));

  registerTexture(scene, OBSTACLE_TEXTURE_KEY, sheet);

  const texture = scene.textures.get(OBSTACLE_TEXTURE_KEY);
  FRAME_ORDER.forEach((kind, i) =>
    texture.add(OBSTACLE_FRAMES[kind], 0, i * size, 0, size, size)
  );
}
