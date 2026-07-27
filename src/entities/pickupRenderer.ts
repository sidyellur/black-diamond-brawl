import Phaser from 'phaser';
import { MAX_ENTITY_SCREEN_FRACTION, SCREEN_W } from '../config';
import { entityDepth } from '../render/depth';
import { ShadowRenderer } from '../render/ShadowRenderer';
import { Camera, projectEntity, softClampWidth } from '../render/projectEntity';
import { DrawnSegment } from '../render/RoadRenderer';
import { Segment } from '../track/segment';
import { laneFraction } from './obstacle';
import { PICKUP_FRAME, PICKUP_FRAME_SIZE, PICKUP_TEXTURE_KEY } from './pickupSprite';
import { Pickup } from './pickup';

// On-screen width as a fraction of the projected road half-width, matching
// the scale conventions in `ObstacleRenderer`/`AIRiderRenderer`.
const WIDTH_FRACTION = 0.3;


/**
 * Draws all not-yet-collected pickups each frame (design-spec §3.5/§3.6),
 * pooling sprites exactly like `ObstacleRenderer` (only ever a draw-distance
 * window's worth are visible at once). A collected pickup is skipped
 * entirely — same as one that's culled/crest-clipped — so it simply
 * disappears the frame it's picked up.
 */
export class PickupRenderer {
  private readonly pool: Phaser.GameObjects.Sprite[] = [];
  private readonly scene: Phaser.Scene;
  /** Called for every sprite the pool creates. The pool grows lazily
   *  mid-race, so a UI camera must be told to ignore each new sprite as it
   *  appears or it renders twice — once in the world, once over the HUD. */
  private readonly onCreate?: (obj: Phaser.GameObjects.GameObject) => void;

  constructor(scene: Phaser.Scene, onCreate?: (obj: Phaser.GameObjects.GameObject) => void) {
    this.scene = scene;
    this.onCreate = onCreate;
  }

  render(
    pickups: Pickup[],
    track: Segment[],
    drawnSegments: Map<number, DrawnSegment>,
    camera: Camera,
    shadows?: ShadowRenderer
  ): void {
    let used = 0;

    for (const pickup of pickups) {
      if (pickup.collected) {
        continue;
      }
      const projected = projectEntity(laneFraction(pickup.lane), pickup.z, track, drawnSegments, camera);
      if (!projected) {
        continue; // behind camera, beyond draw distance, or crest-clipped
      }

      const sprite = this.acquire(used++);
      const widthPx = softClampWidth(
        projected.screenW * WIDTH_FRACTION,
        SCREEN_W * MAX_ENTITY_SCREEN_FRACTION
      );
      sprite.setScale(widthPx / PICKUP_FRAME_SIZE);
      sprite.setPosition(projected.screenX, projected.screenY);
      sprite.setDepth(entityDepth(pickup.z));
      sprite.setVisible(true);
      shadows?.draw(projected.screenX, projected.screenY, widthPx * 0.7);
    }

    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].setVisible(false);
    }
  }

  private acquire(index: number): Phaser.GameObjects.Sprite {
    let sprite = this.pool[index];
    if (!sprite) {
      sprite = this.scene.add.sprite(0, 0, PICKUP_TEXTURE_KEY, PICKUP_FRAME);
      sprite.setOrigin(0.5, 1);
      this.pool[index] = sprite;
      this.onCreate?.(sprite);
    }
    return sprite;
  }
}
