import Phaser from 'phaser';
import { ObstacleKind } from './obstacle';

export const OBSTACLE_TEXTURE_KEY = 'obstacle-sheet';
export const OBSTACLE_FRAME_SIZE = 32;

/** Frame names, one per obstacle kind — `setFrame(OBSTACLE_FRAMES[kind])`. */
export const OBSTACLE_FRAMES: Record<ObstacleKind, string> = {
  tree: 'tree',
  rock: 'rock',
  mogul: 'mogul'
};

const FRAME_ORDER: ObstacleKind[] = ['tree', 'rock', 'mogul'];

// Placeholder pixel-art palette (design-spec §5: simple shapes, not bare
// geometric primitives — these read as a pine, a boulder, a snow bump).
const TREE_FOLIAGE = 0x2f7d4f;
const TREE_FOLIAGE_DARK = 0x246140;
const TREE_TRUNK = 0x6b4423;
const ROCK_BODY = 0x8a8f99;
const ROCK_SHADOW = 0x666b75;
const ROCK_HILIGHT = 0xb8bdc7;
const MOGUL_SNOW = 0xeaf2ff;
const MOGUL_SHADOW = 0xc4d4ea;
const OUTLINE = 0x1a1a1a;

/**
 * Procedurally draws the obstacle sprite sheet (tree / rock / mogul, 32×32
 * each) and registers it as a Phaser texture with named sub-frames. Called
 * once from BootScene; no-ops if the texture already exists.
 */
export function generateObstacleSpriteSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(OBSTACLE_TEXTURE_KEY)) {
    return;
  }

  const size = OBSTACLE_FRAME_SIZE;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  FRAME_ORDER.forEach((kind, i) => drawObstacle(graphics, kind, i * size, size));

  graphics.generateTexture(OBSTACLE_TEXTURE_KEY, size * FRAME_ORDER.length, size);
  graphics.destroy();

  const texture = scene.textures.get(OBSTACLE_TEXTURE_KEY);
  FRAME_ORDER.forEach((kind, i) => texture.add(OBSTACLE_FRAMES[kind], 0, i * size, 0, size, size));
}

/** Each obstacle is drawn to sit on the bottom edge of its frame, so a sprite
 *  anchored at origin (0.5, 1) plants its base on the road surface. */
function drawObstacle(g: Phaser.GameObjects.Graphics, kind: ObstacleKind, ox: number, size: number): void {
  const cx = ox + size / 2;
  const base = size - 1;

  switch (kind) {
    case 'tree': {
      // Trunk.
      g.fillStyle(TREE_TRUNK, 1);
      g.fillRect(cx - 2, base - 8, 4, 8);
      // Three stacked triangular foliage tiers (a stylised pine).
      g.fillStyle(TREE_FOLIAGE, 1);
      fillTriangle(g, cx, base - 30, cx - 11, base - 8, cx + 11, base - 8);
      g.fillStyle(TREE_FOLIAGE_DARK, 1);
      fillTriangle(g, cx, base - 24, cx - 9, base - 12, cx + 9, base - 12);
      g.lineStyle(1, OUTLINE, 0.4);
      g.strokeRect(cx - 2, base - 8, 4, 8);
      break;
    }
    case 'rock': {
      // A chunky boulder with a shadow underside and a highlight cap.
      g.fillStyle(ROCK_SHADOW, 1);
      g.fillRect(cx - 11, base - 6, 22, 6);
      g.fillStyle(ROCK_BODY, 1);
      fillTriangle(g, cx - 11, base - 6, cx + 11, base - 6, cx - 2, base - 17);
      fillTriangle(g, cx + 11, base - 6, cx - 2, base - 17, cx + 9, base - 15);
      g.fillStyle(ROCK_HILIGHT, 1);
      fillTriangle(g, cx - 2, base - 17, cx - 6, base - 9, cx + 2, base - 10);
      break;
    }
    case 'mogul': {
      // A low, wide snow bump.
      g.fillStyle(MOGUL_SHADOW, 1);
      g.fillEllipse(cx, base - 3, 26, 10);
      g.fillStyle(MOGUL_SNOW, 1);
      g.fillEllipse(cx, base - 6, 22, 12);
      break;
    }
  }
}

function fillTriangle(
  g: Phaser.GameObjects.Graphics,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number
): void {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.lineTo(x3, y3);
  g.closePath();
  g.fillPath();
}
