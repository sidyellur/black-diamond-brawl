import Phaser from 'phaser';
import { MAX_ENTITY_SCREEN_FRACTION, SCREEN_W } from '../config';
import { entityDepth } from '../render/depth';
import { ShadowRenderer } from '../render/ShadowRenderer';
import { Camera, projectEntity, softClampWidth } from '../render/projectEntity';
import { DrawnSegment } from '../render/RoadRenderer';
import { Segment } from '../track/segment';
import { AIRider } from './aiRider';
import { AI_RIDER_TEXTURE_KEYS, PLAYER_FRAME_SIZE, PLAYER_FRAMES } from './playerSprite';

// On-screen width of a rider as a fraction of the projected road half-width
// at its depth. Shared verbatim with the player (see RaceScene's
// PLAYER_WIDTH_FRACTION) — the player and its rivals are the same kind of
// object, so any divergence here shows up immediately as rivals that dwarf
// or shrink against the rider you control.
const WIDTH_FRACTION = 0.13;


/**
 * Draws all 4 AI riders each frame (design-spec §3.5/§3.6/§4.5), reusing the
 * SAME entity-projection helper `ObstacleRenderer` uses — riders slide
 * through curves and vanish behind crests exactly like every other entity.
 * Each rider gets a dedicated pooled sprite (stable per rider index, unlike
 * `ObstacleRenderer`'s anonymous draw-order pool — there are only ever 4
 * riders and each keeps its own palette-swapped texture for its lifetime).
 * A rider whose projection is `null` (behind camera, beyond draw distance,
 * or crest-clipped) is simply hidden this frame — its world-Z keeps
 * advancing in `AIRider.update()` regardless, so it reappears at the right
 * spot instead of teleporting.
 */
export class AIRiderRenderer {
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
    riders: AIRider[],
    track: Segment[],
    drawnSegments: Map<number, DrawnSegment>,
    camera: Camera,
    shadows?: ShadowRenderer
  ): void {
    riders.forEach((rider, index) => {
      const sprite = this.acquire(index, rider.params.paletteIndex);
      // Always projected, even for a wiped-out rider: a treed rival stays
      // visible, frozen in a crashed pose at its crash spot, exactly like the
      // player's own wipeout — it isn't despawned, just out of the race (see
      // RaceScene's standings log for "out of the race" bookkeeping).
      const projected = projectEntity(rider.laneOffsetFraction, rider.worldZ, track, drawnSegments, camera);
      if (!projected) {
        sprite.setVisible(false); // behind camera, beyond draw distance, or crest-clipped
        return;
      }

      const lean = rider.leanDirection;
      const frame =
        rider.wipedOut || rider.tumbling
          ? PLAYER_FRAMES.TUMBLE
          : lean < 0
            ? PLAYER_FRAMES.LEAN_LEFT
            : lean > 0
              ? PLAYER_FRAMES.LEAN_RIGHT
              : PLAYER_FRAMES.CENTER;

      sprite.setFrame(frame);
      const widthPx = softClampWidth(
        projected.screenW * WIDTH_FRACTION,
        SCREEN_W * MAX_ENTITY_SCREEN_FRACTION
      );
      sprite.setScale(widthPx / PLAYER_FRAME_SIZE);
      sprite.setPosition(projected.screenX, projected.screenY);
      // Nearer (smaller world-Z) -> higher depth -> drawn on top, same
      // far-to-near convention `ObstacleRenderer` uses.
      sprite.setDepth(entityDepth(rider.worldZ));
      sprite.setVisible(true);
      shadows?.draw(projected.screenX, projected.screenY, widthPx);
    });
  }

  private acquire(index: number, paletteIndex: number): Phaser.GameObjects.Sprite {
    let sprite = this.pool[index];
    if (!sprite) {
      sprite = this.scene.add.sprite(0, 0, AI_RIDER_TEXTURE_KEYS[paletteIndex], PLAYER_FRAMES.CENTER);
      sprite.setOrigin(0.5, 1);
      this.pool[index] = sprite;
      this.onCreate?.(sprite);
    }
    return sprite;
  }
}
