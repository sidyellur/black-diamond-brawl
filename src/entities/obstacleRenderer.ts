import Phaser from 'phaser';
import { MAX_ENTITY_SCREEN_FRACTION, SCREEN_W } from '../config';
import { entityDepth } from '../render/depth';
import { ShadowRenderer } from '../render/ShadowRenderer';
import { Camera, projectEntity, softClampWidth } from '../render/projectEntity';
import { DrawnSegment } from '../render/RoadRenderer';
import { Segment } from '../track/segment';
import { obstacleLaneFraction, Obstacle, ObstacleKind } from './obstacle';
import { OBSTACLE_FRAME_SIZE, OBSTACLE_FRAMES, OBSTACLE_TEXTURE_KEY } from './obstacleSprites';

// On-screen width of each obstacle as a fraction of the projected road
// half-width at its depth — so obstacles scale naturally with the road.
const WIDTH_FRACTION: Record<ObstacleKind, number> = {
  tree: 0.42,
  rock: 0.34,
  mogul: 0.5
};


/**
 * Draws all visible obstacles each frame (design-spec §3.5/§3.6). Pools Phaser
 * sprites (obstacles far outnumber what's ever on-screen: only ~a draw-distance
 * window is visible at once) and, per frame, projects every obstacle with the
 * shared entity-projection helper, hides those culled/crest-clipped, positions/
 * scales the rest, and depth-sorts them far-to-near.
 */
export class ObstacleRenderer {
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
    obstacles: Obstacle[],
    track: Segment[],
    drawnSegments: Map<number, DrawnSegment>,
    camera: Camera,
    shadows?: ShadowRenderer
  ): void {
    let used = 0;

    for (const obstacle of obstacles) {
      const projected = projectEntity(
        obstacleLaneFraction(obstacle),
        obstacle.z,
        track,
        drawnSegments,
        camera
      );
      if (!projected) {
        continue; // behind camera, beyond draw distance, or crest-clipped
      }

      const sprite = this.acquire(used++);
      sprite.setFrame(OBSTACLE_FRAMES[obstacle.kind]);
      // Origin bottom-centre plants the base on the projected road surface.
      const widthPx = softClampWidth(
        projected.screenW * WIDTH_FRACTION[obstacle.kind],
        SCREEN_W * MAX_ENTITY_SCREEN_FRACTION
      );
      sprite.setScale(widthPx / OBSTACLE_FRAME_SIZE);
      sprite.setPosition(projected.screenX, projected.screenY);
      // Nearer (smaller world-Z) → higher depth → drawn on top (far-to-near).
      sprite.setDepth(entityDepth(obstacle.z));
      sprite.setVisible(true);
      // Moguls are part of the surface, so they cast no separate shadow —
      // their own shading already carries one.
      if (shadows && obstacle.kind !== 'mogul') {
        shadows.draw(projected.screenX, projected.screenY, widthPx * 0.75);
      }
    }

    // Hide any pooled sprites not used this frame.
    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].setVisible(false);
    }
  }

  private acquire(index: number): Phaser.GameObjects.Sprite {
    let sprite = this.pool[index];
    if (!sprite) {
      sprite = this.scene.add.sprite(0, 0, OBSTACLE_TEXTURE_KEY, OBSTACLE_FRAMES.tree);
      sprite.setOrigin(0.5, 1);
      this.pool[index] = sprite;
      this.onCreate?.(sprite);
    }
    return sprite;
  }
}
