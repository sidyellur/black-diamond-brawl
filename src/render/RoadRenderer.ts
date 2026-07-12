import Phaser from 'phaser';
import { DRAW_DISTANCE, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { Segment } from '../track/segment';
import { project } from './project';

// Snow surface shading, alternating by segment.colorBand.
const SNOW_LIGHT = 0xf5f9ff;
const SNOW_DARK = 0xe4ecf7;

// Off-piste snow, alternating by segment.colorBand.
const OFF_PISTE_LIGHT = 0xdcecff;
const OFF_PISTE_DARK = 0xcbe0f7;

// Edge rumble strips, alternating by segment.colorBand.
const RUMBLE_LIGHT = 0xc0392b;
const RUMBLE_DARK = 0xffffff;

// Rumble strip half-width as a multiple of the road's projected half-width.
const RUMBLE_WIDTH_RATIO = 1.1;

/**
 * Draws the road (design-spec §3.6 steps 1-2, this task covers step 2 —
 * step 1's static sky is set once as the scene's camera background color).
 *
 * This task's track is flat and straight (curve=0, y=0 everywhere), so no
 * curve-offset accumulation or crest-clipping logic is implemented here —
 * that's Task 3's job. Segments are drawn front-to-back (near to far),
 * matching the render order the crest-clipping algorithm will need later.
 */
export class RoadRenderer {
  private readonly graphics: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }

  render(track: Segment[], camX: number, camY: number, camZ: number): void {
    this.graphics.clear();

    if (track.length === 0) {
      return;
    }

    const trackLength = track.length * SEGMENT_LENGTH;
    const baseIndex = Math.floor(camZ / SEGMENT_LENGTH) % track.length;

    for (let i = 0; i < DRAW_DISTANCE; i++) {
      const drawIndex = baseIndex + i;
      const segIndex = drawIndex % track.length;
      const loopCount = Math.floor(drawIndex / track.length);
      const segment = track[segIndex];

      // World-Z of this draw slot, offset by however many times the fixed
      // track array has looped so it stays continuous with camZ instead of
      // jumping back to zero (the "loop back to the start" requirement).
      const nearZ = segment.z + loopCount * trackLength;
      const farZ = nearZ + SEGMENT_LENGTH;

      const near = project(0, segment.y, nearZ, camX, camY, camZ);
      const far = project(0, segment.y, farZ, camX, camY, camZ);

      // Behind-camera clamp (§3.4): skip any edge with dz <= 0 rather than
      // draw/divide with an invalid projection.
      if (!near || !far) {
        continue;
      }

      const dark = segment.colorBand === 0;

      this.fillTrapezoid(
        0, SCREEN_W, near.screenY,
        0, SCREEN_W, far.screenY,
        dark ? OFF_PISTE_DARK : OFF_PISTE_LIGHT
      );

      const nearRumbleW = near.screenW * RUMBLE_WIDTH_RATIO;
      const farRumbleW = far.screenW * RUMBLE_WIDTH_RATIO;
      this.fillTrapezoid(
        near.screenX - nearRumbleW, near.screenX + nearRumbleW, near.screenY,
        far.screenX - farRumbleW, far.screenX + farRumbleW, far.screenY,
        dark ? RUMBLE_DARK : RUMBLE_LIGHT
      );

      this.fillTrapezoid(
        near.screenX - near.screenW, near.screenX + near.screenW, near.screenY,
        far.screenX - far.screenW, far.screenX + far.screenW, far.screenY,
        dark ? SNOW_DARK : SNOW_LIGHT
      );
    }
  }

  private fillTrapezoid(
    nearLeftX: number, nearRightX: number, nearY: number,
    farLeftX: number, farRightX: number, farY: number,
    color: number
  ): void {
    this.graphics.fillStyle(color);
    this.graphics.beginPath();
    this.graphics.moveTo(nearLeftX, nearY);
    this.graphics.lineTo(nearRightX, nearY);
    this.graphics.lineTo(farRightX, farY);
    this.graphics.lineTo(farLeftX, farY);
    this.graphics.closePath();
    this.graphics.fillPath();
  }
}
