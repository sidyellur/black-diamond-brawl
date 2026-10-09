import Phaser from 'phaser';
import { DRAW_DISTANCE, MAX_ENTITY_SCREEN_FRACTION, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { OBSTACLE_FRAME_SIZE, OBSTACLE_TEXTURE_KEY, TREE_VARIANT_FRAMES } from '../entities/obstacleSprites';
import { themeAtSegment } from '../track/mountain';
import { Segment } from '../track/segment';
import { entityDepth } from './depth';
import { Camera, projectEntity, softClampWidth } from './projectEntity';
import { DrawnSegment } from './RoadRenderer';

interface SceneryPoint {
  z: number;
  segment: number;
  side: number;
  hash: number;
}

/** Immutable, sorted candidates; theme selection reads the same segment as
 * geometry and collision placement. Scenery never consumes the gameplay RNG
 * and always stands beyond the five playable lanes. At most DRAW_DISTANCE / 3
 * candidates are visited in a frame, independent of whole-course length. */
export class SceneryRenderer {
  private readonly pool: Phaser.GameObjects.Sprite[] = [];
  private readonly scenery: SceneryPoint[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    seed: number,
    segmentCount: number,
    private readonly register: (object: Phaser.GameObjects.GameObject) => void
  ) {
    for (let segment = 12; segment < segmentCount - 4; segment += 6) {
      for (const side of [-1, 1]) {
        let hash = (Math.imul(segment + (side > 0 ? 173 : 0), 0x45d9f3b) ^ seed) >>> 0;
        hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
        this.scenery.push({ z: (segment + ((hash >>> 8) % 4)) * SEGMENT_LENGTH, segment, side, hash });
      }
    }
    this.scenery.sort((a, b) => a.z - b.z);
  }

  render(track: Segment[], drawn: Map<number, DrawnSegment>, camera: Camera): void {
    let used = 0;
    let lo = 0;
    let hi = this.scenery.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.scenery[mid].z < camera.z) lo = mid + 1;
      else hi = mid;
    }
    const farZ = camera.z + DRAW_DISTANCE * SEGMENT_LENGTH;
    for (let index = lo; index < this.scenery.length; index++) {
      const item = this.scenery[index];
      if (item.z > farZ) break;
      const segment = track[Math.floor(item.z / SEGMENT_LENGTH)];
      const theme = themeAtSegment(segment);
      const h = item.hash;
      const slot = Math.floor(item.segment / 6);
      // Dense treelines, sparse exposed rock teeth, then a broad treeless
      // bowl. These densities and silhouettes remain distinct in grayscale.
      if (theme === 'ridge' && slot % 3 !== 0) continue;
      if (theme === 'bowl' && slot % 5 !== 0) continue;
      const lane = item.side * (theme === 'forest' ? 1.38 + (h % 70) / 140
        : theme === 'ridge' ? 1.38 + (h % 70) / 130 : 1.95 + (h % 70) / 100);
      const at = projectEntity(lane, item.z, track, drawn, camera);
      if (!at || at.screenX < -180 || at.screenX > SCREEN_W + 180) continue;
      let sprite = this.pool[used++];
      if (!sprite) {
        sprite = this.scene.add.sprite(0, 0, OBSTACLE_TEXTURE_KEY, 'tree').setOrigin(0.5, 1);
        this.pool.push(sprite);
        this.register(sprite);
      }
      const scale = theme === 'forest' ? 0.45 + ((h >>> 16) % 100) / 350
        : theme === 'ridge' ? 0.5 + ((h >>> 16) % 100) / 200 : 0.28;
      const width = softClampWidth(at.screenW * scale, SCREEN_W * MAX_ENTITY_SCREEN_FRACTION);
      const distance = Math.min(1, Math.max(0, (item.z - camera.z) / (DRAW_DISTANCE * SEGMENT_LENGTH)));
      const frame = theme === 'forest' ? TREE_VARIANT_FRAMES[(h >>> 2) % TREE_VARIANT_FRAMES.length]
        : theme === 'ridge' ? 'rock' : 'mogul';
      sprite.setFrame(frame);
      sprite.setVisible(true).setPosition(at.screenX, at.screenY).setScale(width / OBSTACLE_FRAME_SIZE);
      sprite.setFlipX((h & 1) === 1).setDepth(entityDepth(item.z) - 1);
      sprite.setTint(theme === 'forest' ? 0xb4ccd6 : theme === 'ridge' ? 0xc2d2e4 : 0xe4ecf4)
        .setAlpha(0.92 - distance * 0.32);
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }
}
