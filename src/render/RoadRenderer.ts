import Phaser from 'phaser';
import { DRAW_DISTANCE, SCREEN_H, SCREEN_W, SEGMENT_LENGTH } from '../config';
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
 * Result of a single `render()` pass. `clippedSegments` holds the track-array
 * indices whose road was hidden behind a crest this frame (design-spec §3.4).
 * Task 6 reuses this exact clip decision to hide obstacle/entity sprites that
 * sit on clipped segments, so it is exposed here rather than kept as a local.
 */
export interface RenderResult {
  clippedSegments: Set<number>;
}

/**
 * Draws the road (design-spec §3.6 steps 1-2). Implements curves via the
 * corrected near/far-edge offset walk (§3.3), per-segment elevation and the
 * front-to-back crest-clipping rule (§3.4). Segments are drawn front-to-back
 * (near to far) so the crest clip can accumulate a running minimum screen-Y.
 */
export class RoadRenderer {
  private readonly graphics: Phaser.GameObjects.Graphics;

  /** Segments clipped behind a crest on the most recent frame (§3.4). Public
   *  so Task 6 can reuse the same clip decision for entity/sprite hiding. */
  public clippedSegments: Set<number> = new Set();

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }

  render(track: Segment[], camX: number, camY: number, camZ: number): RenderResult {
    this.graphics.clear();

    const clippedSegments = new Set<number>();
    this.clippedSegments = clippedSegments;

    if (track.length === 0) {
      return { clippedSegments };
    }

    const len = track.length;
    const trackLength = len * SEGMENT_LENGTH;
    const baseIndex = Math.floor(camZ / SEGMENT_LENGTH) % len;

    // Base-segment fraction seed (§3.3): the camera's fractional position
    // within its own segment. Seeding `dx` with it keeps the offset walk
    // continuous as the camera crosses segment boundaries (prevents popping).
    const baseSegmentFraction = (camZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    const baseSegment = track[baseIndex];

    // Accumulated horizontal offset walk (§3.3). `x` is the near-edge offset
    // of the segment about to be drawn; `dx` is the per-segment delta.
    let x = 0;
    let dx = -(baseSegment.curve * baseSegmentFraction);

    // Running minimum projected screen-Y for crest clipping (§3.4). Numerically
    // smaller = higher on screen. Starts at the bottom of the screen so nothing
    // is clipped until a crest raises the line.
    let minScreenY = SCREEN_H;

    for (let i = 0; i < DRAW_DISTANCE; i++) {
      const drawIndex = baseIndex + i;
      const segIndex = drawIndex % len;
      const loopCount = Math.floor(drawIndex / len);
      const segment = track[segIndex];

      // World-Z of this draw slot, offset by however many times the fixed
      // track array has looped so it stays continuous with camZ.
      const nearZ = segment.z + loopCount * trackLength;
      const farZ = nearZ + SEGMENT_LENGTH;

      // Near-edge elevation is the previous segment's far `y`; far-edge
      // elevation is this segment's own `y` (§3.4).
      const nearElev = track[(segIndex - 1 + len) % len].y;
      const farElev = segment.y;

      // §3.3: project the NEAR edge with the current `x`, the FAR edge with
      // `x + dx`. The curve offset is added to the edge's world-X.
      const near = project(x, nearElev, nearZ, camX, camY, camZ);
      const far = project(x + dx, farElev, farZ, camX, camY, camZ);

      // §3.3: advance the walk ONLY after both edges are projected. The next
      // segment's near edge then reuses exactly this segment's far offset
      // (`x + dx`), so the trapezoids tile with no crack.
      x += dx;
      dx += segment.curve;

      // Behind-camera clamp (§3.4 / Task 2): skip if either edge is at or
      // behind the camera. The walk was already advanced above, so the
      // accumulation stays correct even for skipped segments.
      if (!near || !far) {
        continue;
      }

      // Crest clip (§3.4): skip any segment whose far edge would draw at or
      // below the highest line drawn so far (far-edge screen-Y numerically
      // >= running minimum). Record it so Task 6 can hide sprites on it.
      if (far.screenY >= minScreenY) {
        clippedSegments.add(segIndex);
        continue;
      }
      minScreenY = far.screenY;

      const dark = segment.colorBand === 0;

      // Off-piste fills the full screen width behind the road (unaffected by
      // the curve offset).
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

    return { clippedSegments };
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
