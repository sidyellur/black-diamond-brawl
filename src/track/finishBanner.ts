import Phaser from 'phaser';
import { ROAD_WIDTH } from '../config';
import { project, ProjectedPoint } from '../render/project';
import { Segment } from './segment';

// World-Y height of the banner arch above the road surface.
const BANNER_HEIGHT = 1800;
const CHECKER_COLUMNS = 8;
const CHECKER_COLOR_A = 0xd94f4f;
const CHECKER_COLOR_B = 0xffffff;
const POLE_COLOR = 0x555b66;

/**
 * Draws the finish banner: a checkered bar spanning the road at the finish
 * segment, with a pole at each edge. Task 6 hasn't formalized a general
 * entity-projection system yet, so this projects its own corner points
 * directly with `project()` (the same function `RoadRenderer` uses for
 * segment edges) rather than building one — a deliberately minimal "sprite"
 * for this task, not a general entity.
 */
export class FinishBanner {
  private readonly graphics: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }

  render(finishSegment: Segment | undefined, camX: number, camY: number, camZ: number): void {
    this.graphics.clear();
    if (!finishSegment) {
      return;
    }

    const z = finishSegment.z;
    const roadY = finishSegment.y;

    const baseLeft = project(-ROAD_WIDTH, roadY, z, camX, camY, camZ);
    const baseRight = project(ROAD_WIDTH, roadY, z, camX, camY, camZ);
    const topLeft = project(-ROAD_WIDTH, roadY + BANNER_HEIGHT, z, camX, camY, camZ);
    const topRight = project(ROAD_WIDTH, roadY + BANNER_HEIGHT, z, camX, camY, camZ);

    if (!baseLeft || !baseRight || !topLeft || !topRight) {
      return; // behind the camera; nothing to draw this frame
    }

    this.drawPole(baseLeft, topLeft);
    this.drawPole(baseRight, topRight);
    this.drawCheckeredBar(baseLeft, baseRight, topLeft, topRight);
  }

  private drawPole(base: ProjectedPoint, top: ProjectedPoint): void {
    this.graphics.lineStyle(Math.max(1, base.scale * 30), POLE_COLOR, 1);
    this.graphics.lineBetween(base.screenX, base.screenY, top.screenX, top.screenY);
  }

  private drawCheckeredBar(baseLeft: ProjectedPoint, baseRight: ProjectedPoint, topLeft: ProjectedPoint, topRight: ProjectedPoint): void {
    for (let col = 0; col < CHECKER_COLUMNS; col++) {
      const fracA = col / CHECKER_COLUMNS;
      const fracB = (col + 1) / CHECKER_COLUMNS;
      const color = col % 2 === 0 ? CHECKER_COLOR_A : CHECKER_COLOR_B;

      this.fillQuad(
        lerpPoint(baseLeft, baseRight, fracA),
        lerpPoint(baseLeft, baseRight, fracB),
        lerpPoint(topLeft, topRight, fracB),
        lerpPoint(topLeft, topRight, fracA),
        color
      );
    }
  }

  private fillQuad(p1: ScreenPoint, p2: ScreenPoint, p3: ScreenPoint, p4: ScreenPoint, color: number): void {
    this.graphics.fillStyle(color);
    this.graphics.beginPath();
    this.graphics.moveTo(p1.x, p1.y);
    this.graphics.lineTo(p2.x, p2.y);
    this.graphics.lineTo(p3.x, p3.y);
    this.graphics.lineTo(p4.x, p4.y);
    this.graphics.closePath();
    this.graphics.fillPath();
  }
}

interface ScreenPoint {
  x: number;
  y: number;
}

function lerpPoint(a: ProjectedPoint, b: ProjectedPoint, t: number): ScreenPoint {
  return {
    x: a.screenX + (b.screenX - a.screenX) * t,
    y: a.screenY + (b.screenY - a.screenY) * t
  };
}
