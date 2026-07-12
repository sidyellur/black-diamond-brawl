import Phaser from 'phaser';

export const PICKUP_TEXTURE_KEY = 'pickup-sheet';
export const PICKUP_FRAME_SIZE = 32;
export const PICKUP_FRAME = 'ski-pole';

// Placeholder pixel-art palette (design-spec §5), matching the simple-shapes
// treatment `obstacleSprites.ts` uses — a crossed pair of ski poles with
// baskets, planted upright so it reads clearly against the snow.
const POLE_SHAFT = 0xd94f4f;
const POLE_GRIP = 0x1a1a1a;
const POLE_BASKET = 0xffcc33;

/**
 * Procedurally draws the ski-pole pickup sprite (32×32) and registers it as a
 * Phaser texture with a single named frame. Called once from BootScene;
 * no-ops if the texture already exists.
 */
export function generatePickupSpriteSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(PICKUP_TEXTURE_KEY)) {
    return;
  }

  const size = PICKUP_FRAME_SIZE;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  drawPickup(graphics, size);

  graphics.generateTexture(PICKUP_TEXTURE_KEY, size, size);
  graphics.destroy();

  const texture = scene.textures.get(PICKUP_TEXTURE_KEY);
  texture.add(PICKUP_FRAME, 0, 0, 0, size, size);
}

/** Drawn to sit on the bottom edge of its frame, so a sprite anchored at
 *  origin (0.5, 1) plants its base on the road surface — same convention
 *  `obstacleSprites.ts` uses. */
function drawPickup(g: Phaser.GameObjects.Graphics, size: number): void {
  const cx = size / 2;
  const base = size - 1;

  const drawPole = (tiltPx: number): void => {
    g.lineStyle(3, POLE_SHAFT, 1);
    g.lineBetween(cx - tiltPx, base - 2, cx + tiltPx, base - 28);
    g.fillStyle(POLE_BASKET, 1);
    g.fillCircle(cx - tiltPx * 0.75, base - 8, 3);
    g.fillStyle(POLE_GRIP, 1);
    g.fillRect(cx + tiltPx - 2, base - 30, 4, 5);
  };

  drawPole(-6);
  drawPole(6);
}
