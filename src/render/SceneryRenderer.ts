import Phaser from 'phaser';
import { MAX_ENTITY_SCREEN_FRACTION, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { OBSTACLE_FRAME_SIZE, OBSTACLE_TEXTURE_KEY, TREE_VARIANT_FRAMES } from '../entities/obstacleSprites';
import { Segment } from '../track/segment';
import { entityDepth } from './depth';
import { Camera, projectEntity, softClampWidth } from './projectEntity';
import { DrawnSegment } from './RoadRenderer';

/** Deterministic scenery lives strictly beyond the playable piste. It uses
 * the same projection and crest visibility as hazards, but never enters the
 * placement RNG or collision system. Pooled sprites keep each frame cheap. */
export class SceneryRenderer {
  private readonly pool: Phaser.GameObjects.Sprite[] = [];
  private readonly scenery: { z: number; lane: number; scale: number; mirror: boolean; frame: string }[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    seed: number,
    segmentCount: number,
    private readonly register: (object: Phaser.GameObjects.GameObject) => void
  ) {
    for (let segment = 14; segment < segmentCount - 4; segment += 12) {
      for (const side of [-1, 1]) {
        let h = (Math.imul(segment + (side > 0 ? 173 : 0), 0x45d9f3b) ^ seed) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        this.scenery.push({
          z: (segment + ((h >>> 8) % 5)) * SEGMENT_LENGTH,
          lane: side * (1.27 + (h % 100) / 125),
          scale: 0.39 + ((h >>> 16) % 100) / 400,
          mirror: (h & 1) === 1,
          frame: TREE_VARIANT_FRAMES[(h >>> 2) % TREE_VARIANT_FRAMES.length]
        });
      }
    }
  }

  render(track: Segment[], drawn: Map<number, DrawnSegment>, camera: Camera): void {
    let used = 0;
    for (const tree of this.scenery) {
      if (tree.z < camera.z || tree.z > camera.z + 20000) continue;
      const at = projectEntity(tree.lane, tree.z, track, drawn, camera);
      if (!at || at.screenX < -180 || at.screenX > SCREEN_W + 180) continue;
      let sprite = this.pool[used++];
      if (!sprite) {
        sprite = this.scene.add.sprite(0, 0, OBSTACLE_TEXTURE_KEY, 'tree').setOrigin(0.5, 1);
        this.pool.push(sprite);
        this.register(sprite);
      }
      const width = softClampWidth(at.screenW * tree.scale, SCREEN_W * MAX_ENTITY_SCREEN_FRACTION);
      const distance = Math.min(1, Math.max(0, (tree.z - camera.z) / 20000));
      sprite.setFrame(tree.frame);
      sprite.setVisible(true).setPosition(at.screenX, at.screenY).setScale(width / OBSTACLE_FRAME_SIZE);
      sprite.setFlipX(tree.mirror).setDepth(entityDepth(tree.z) - 1);
      // Cooler and softer than the on-piste hazards, preserving the gameplay
      // hierarchy while suggesting a wider alpine world around the course.
      sprite.setTint(0xb4ccd6).setAlpha(0.92 - distance * 0.32);
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }
}
