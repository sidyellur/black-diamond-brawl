import Phaser from 'phaser';
import { MAX_ENTITY_SCREEN_FRACTION, SCREEN_W } from '../config';
import { DEPTH } from './depth';
import { softClampWidth } from './projectEntity';
import { SHADOW_SIZE, SHADOW_TEXTURE_KEY } from './shadowSprite';

/**
 * Pooled contact shadows.
 *
 * Each shadow is its own sprite rather than one batched Graphics pass: a
 * single batched layer would have one depth, so a near entity's shadow would
 * draw over a *far* entity's body. Per-sprite shadows sit in their own depth
 * band below all entities, which sorts correctly against everything.
 */
export class ShadowRenderer {
  private readonly pool: Phaser.GameObjects.Sprite[] = [];
  private readonly scene: Phaser.Scene;
  private readonly onCreate?: (obj: Phaser.GameObjects.GameObject) => void;
  private used = 0;

  constructor(scene: Phaser.Scene, onCreate?: (obj: Phaser.GameObjects.GameObject) => void) {
    this.scene = scene;
    this.onCreate = onCreate;
  }

  /** Call once per frame before any `draw` calls. */
  begin(): void {
    this.used = 0;
  }

  /**
   * @param screenX  where the object stands
   * @param groundY  the road surface Y under it — NOT the sprite's own Y, so
   *                 an airborne rider's shadow stays on the ground
   * @param widthPx  the object's on-screen width
   * @param height01 0 when planted, 1 at full jump height; shrinks and fades
   *                 the shadow so altitude is readable
   */
  draw(screenX: number, groundY: number, widthPx: number, height01 = 0): void {
    const sprite = this.acquire(this.used++);
    // A shadow shrinks as its caster rises — the size gap is what communicates
    // height, more than the vertical offset does.
    const shrink = 1 - height01 * 0.45;
    const w = softClampWidth(widthPx * 1.05 * shrink, SCREEN_W * MAX_ENTITY_SCREEN_FRACTION);
    sprite.setDisplaySize(w, w * 0.5);
    sprite.setPosition(screenX, groundY);
    sprite.setAlpha((1 - height01 * 0.55) * 0.9);
    sprite.setVisible(true);
  }

  /** Hides any shadow not drawn this frame. */
  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      this.pool[i].setVisible(false);
    }
  }

  private acquire(index: number): Phaser.GameObjects.Sprite {
    let sprite = this.pool[index];
    if (!sprite) {
      sprite = this.scene.add.sprite(0, 0, SHADOW_TEXTURE_KEY);
      sprite.setOrigin(0.5, 0.5);
      sprite.setDepth(DEPTH.SHADOW);
      this.pool[index] = sprite;
      this.onCreate?.(sprite);
    }
    return sprite;
  }

  get frameSize(): number {
    return SHADOW_SIZE;
  }
}
