import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { RUMBLE, SNOW, UI, shade } from '../render/palette';
import { Camera, projectEntity } from '../render/projectEntity';
import { DrawnSegment } from '../render/RoadRenderer';
import { Segment } from './segment';

// The hanging fabric is only the top of the arch. Everything below it stays
// open so the finish reads as a place to ride through, never as a solid wall.
const BANNER_HEIGHT = 1800;
const BANNER_FABRIC_HEIGHT = 260;
const CHECKER_COLUMNS = 12;
const CHECKER_ROWS = 2;
const POLE_WORLD_WIDTH = 46;
const POLE_COLOR = 0x8b93a1;
const POLE_SHADE = shade(POLE_COLOR, 'shadow');

/** A genuine overhead finish arch, attached to the same curved/elevated
 * segment as the riders. projectEntity owns all visibility decisions: an
 * arch beyond draw distance or behind a crest cannot float over the skyline. */
export class FinishBanner {
  private readonly graphics: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }

  get displayObjects(): Phaser.GameObjects.GameObject[] {
    return [this.graphics];
  }

  setDepth(depth: number): void {
    this.graphics.setDepth(depth);
  }

  render(
    finishSegment: Segment | undefined,
    track: Segment[],
    drawnSegments: Map<number, DrawnSegment>,
    camera: Camera
  ): void {
    this.graphics.clear();
    if (!finishSegment) return;

    const ground = projectEntity(0, finishSegment.z, track, drawnSegments, camera);
    if (!ground) return;

    const halfWidth = ground.screenW * 1.035;
    const left = ground.screenX - halfWidth;
    const right = ground.screenX + halfWidth;
    const top = ground.screenY - ground.scale * BANNER_HEIGHT * (SCREEN_H / 2);
    const barHeight = Math.max(2, ground.scale * BANNER_FABRIC_HEIGHT * (SCREEN_H / 2));
    const poleWidth = Math.max(1.5, ground.scale * POLE_WORLD_WIDTH * (SCREEN_W / 2));

    this.drawPole(left, ground.screenY, top, poleWidth);
    this.drawPole(right, ground.screenY, top, poleWidth);

    // Fabric header/footer seams keep the white checks readable against snow.
    this.graphics.fillStyle(UI.panel);
    this.graphics.fillRect(left, top - 1, right - left, barHeight + 2);
    const cellWidth = (right - left) / CHECKER_COLUMNS;
    const cellHeight = barHeight / CHECKER_ROWS;
    for (let row = 0; row < CHECKER_ROWS; row++) {
      for (let column = 0; column < CHECKER_COLUMNS; column++) {
        this.graphics.fillStyle((row + column) % 2 === 0 ? RUMBLE.warn : SNOW.packed);
        this.graphics.fillRect(
          left + column * cellWidth, top + row * cellHeight,
          cellWidth + 0.25, cellHeight
        );
      }
    }
  }

  private drawPole(x: number, baseY: number, topY: number, width: number): void {
    this.graphics.lineStyle(width, POLE_SHADE, 1);
    this.graphics.lineBetween(x, baseY, x, topY);
    this.graphics.lineStyle(Math.max(1, width * 0.42), POLE_COLOR, 1);
    this.graphics.lineBetween(x - width * 0.18, baseY, x - width * 0.18, topY);
    // Small snow feet plant the poles on the surface without a giant shadow.
    this.graphics.fillStyle(SNOW.shadow, 0.7);
    this.graphics.fillEllipse(x + width * 0.35, baseY, width * 2.2, width * 0.55);
  }
}
