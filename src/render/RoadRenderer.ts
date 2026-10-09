import Phaser from 'phaser';
import { DRAW_DISTANCE, SCREEN_H, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { Segment } from '../track/segment';
import { RUMBLE, SNOW, mix } from './palette';
import { project } from './project';

// All surface colours now come from the shared palette rather than being
// declared here, so the road and the sprites standing on it are guaranteed to
// be shaded by the same system. The piste/off-piste separation is held above
// MIN_GAMEPLAY_DELTA_L by `verify:palette` — before that gate existed the
// track edge sat at ΔL* 5, which is why it was so hard to see where the
// raceable surface ended.
const SNOW_LIGHT = SNOW.packed;
const SNOW_DARK = SNOW.packedAlt;

const OFF_PISTE_LIGHT = SNOW.offPiste;
const OFF_PISTE_DARK = SNOW.offPisteAlt;

// A sculpted shoulder, with sparse marker poles instead of a highway curb.
const EDGE_WIDTH_RATIO = 1.012;
const SNOWBANK_WIDTH_RATIO = 1.13;
const SURFACE_BANDS = 16;

/** How far the off-piste fill overshoots each screen edge. The world is drawn
 *  in screen space with camera scroll pinned at 0, so a `camera.shake()` on
 *  impact translates the whole view and would otherwise reveal the black page
 *  behind the canvas along one edge. */
const SHAKE_BLEED_PX = 48;

/** How many near segments get corduroy grooming lines. Past this the lines are
 *  sub-pixel and read as shimmer rather than texture — the Nyquist limit, and
 *  the reason this is capped rather than drawn to the horizon. */
const CORDUROY_SEGMENTS = 18;
const CORDUROY_LINES = 9;

/**
 * Per-drawn-segment horizontal offset walk data (design-spec §3.3), recorded so
 * entity projection (§3.5) can interpolate an entity's curve offset between the
 * exact near-edge (`nearOffsetX`) and far-edge (`farOffsetX`) offsets this
 * segment's road trapezoid was drawn with — NOT a single snapped per-segment
 * value, which would stair-step entities across segment boundaries.
 */
export interface DrawnSegment {
  /** Accumulated curve offset at the segment's near edge (its world-X). */
  nearOffsetX: number;
  /** Accumulated curve offset at the segment's far edge (`x + dx`). */
  farOffsetX: number;
  /** True if this segment's road was hidden behind a crest this frame (§3.4). */
  clipped: boolean;
}

/**
 * Result of a single `render()` pass. `clippedSegments` holds the track-array
 * indices whose road was hidden behind a crest this frame (design-spec §3.4).
 * `drawnSegments` maps every segment index that was in front of the camera this
 * frame (whether drawn or crest-clipped) to its offset-walk data, so entity
 * projection can look up the exact near/far offsets to interpolate between.
 * Entities whose segment is absent (behind camera / beyond draw distance) or
 * flagged `clipped` must be hidden (§3.5).
 */
export interface RenderResult {
  clippedSegments: Set<number>;
  drawnSegments: Map<number, DrawnSegment>;
  /**
   * Screen-Y of the highest (numerically smallest) road edge drawn this frame
   * — i.e. where the snow actually stops.
   *
   * The backdrop cannot be anchored to a constant horizon, because there
   * isn't one: on flat ground the road tops out around y=281, climbing a rise
   * it can cover the whole screen, and cresting a hill the clip terminates the
   * draw early and the road can stop as low as y=320+. Anchoring mountains to
   * a fixed line would leave them floating over a gap of bare sky on every
   * crest — and crests are a core feature of the generator. The haze band is
   * drawn from this value instead, so the join is seamless by construction.
   *
   * `SCREEN_H` when no road was drawn at all.
   */
  topScreenY: number;
  /**
   * Accumulated horizontal curve offset at the far end of the drawn road.
   * Parallax layers shift by a depth-scaled fraction of this so the backdrop
   * swings with the track through a bend instead of sitting there like
   * wallpaper.
   */
  farCurveOffset: number;
}

interface SurfaceShades {
  snow: number;
  offPiste: number;
  bankLit: number;
  bankShadow: number;
  seam: number;
  corduroy: number;
}

/**
 * Draws the road (design-spec §3.6 steps 1-2). Implements curves via the
 * corrected near/far-edge offset walk (§3.3), per-segment elevation and the
 * front-to-back crest-clipping rule (§3.4). Segments are drawn front-to-back
 * (near to far) so the crest clip can accumulate a running minimum screen-Y.
 */
export class RoadRenderer {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private lastFogColor = -1;
  private readonly shades: SurfaceShades[] = Array.from({ length: DRAW_DISTANCE * SURFACE_BANDS }, () => ({
    snow: 0, offPiste: 0, bankLit: 0, bankShadow: 0, seam: 0, corduroy: 0
  }));
  private readonly markers = Array.from({ length: 20 }, () => ({ x: 0, y: 0, height: 0, width: 0, alpha: 0 }));
  private markerCount = 0;
  // Projection records are consumed during this frame only. Reusing the
  // containers and slots avoids 100 tiny objects plus Map/Set each frame.
  private readonly offsetPool: DrawnSegment[] = Array.from(
    { length: DRAW_DISTANCE }, () => ({ nearOffsetX: 0, farOffsetX: 0, clipped: false })
  );

  /** Segments clipped behind a crest on the most recent frame (§3.4). Public
   *  so Task 6 can reuse the same clip decision for entity/sprite hiding. */
  public clippedSegments: Set<number> = new Set();

  /** Offset-walk data for every in-front-of-camera segment this frame (§3.5),
   *  so entity projection can interpolate near/far curve offsets. */
  public drawnSegments: Map<number, DrawnSegment> = new Map();

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }

  /** See `SkyRenderer.displayObjects`. */
  get displayObjects(): Phaser.GameObjects.GameObject[] {
    return [this.graphics];
  }

  /** Sets the road graphics' render depth (design-spec §3.6 render order). */
  setDepth(depth: number): void {
    this.graphics.setDepth(depth);
  }

  render(track: Segment[], camX: number, camY: number, camZ: number, fogColor: number): RenderResult {
    this.graphics.clear();
    this.prepareShades(fogColor);
    this.markerCount = 0;

    const clippedSegments = this.clippedSegments;
    const drawnSegments = this.drawnSegments;
    clippedSegments.clear();
    drawnSegments.clear();

    let topScreenY = SCREEN_H;
    let farCurveOffset = 0;

    if (track.length === 0) {
      return { clippedSegments, drawnSegments, topScreenY, farCurveOffset };
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
    // smaller = higher on screen. Starts at +Infinity — i.e. "no baseline
    // established yet" — rather than SCREEN_H: a segment immediately in front
    // of the camera can legitimately project with screenY WELL past SCREEN_H
    // (CAMERA_HEIGHT's steep look-down angle at tiny dz dominates the
    // projection), which is not a crest at all, just very-near geometry. That
    // used to make the very first segment(s) processed spuriously self-clip
    // (harmless for the road trapezoid itself, since it's off-screen either
    // way, but it also hid any entity — e.g. Task 7's AI riders — sitting in
    // one of those first few segments via `projectEntity`, even when the
    // rider was clearly meant to be visible right in front of the camera).
    // Seeding at Infinity means the first processed segment always establishes
    // the baseline instead of being compared against a bound it can trivially
    // exceed; every subsequent real crest comparison is unchanged.
    let minScreenY = Infinity;

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
      const nearOffsetX = x;
      const farOffsetX = x + dx;
      const near = project(nearOffsetX, nearElev, nearZ, camX, camY, camZ);
      const far = project(farOffsetX, farElev, farZ, camX, camY, camZ);

      // §3.3: advance the walk ONLY after both edges are projected. The next
      // segment's near edge then reuses exactly this segment's far offset
      // (`x + dx`), so the trapezoids tile with no crack.
      x += dx;
      dx += segment.curve;

      // Behind-camera clamp (§3.4 / Task 2): skip if either edge is at or
      // behind the camera. The walk was already advanced above, so the
      // accumulation stays correct even for skipped segments. Nothing is
      // recorded for these — entities on them are hidden by absence (§3.5).
      if (!near || !far) {
        continue;
      }

      // Crest clip (§3.4): skip any segment whose far edge would draw at or
      // below the highest line drawn so far (far-edge screen-Y numerically
      // >= running minimum). Record the offsets either way (so an entity on a
      // clipped segment is recognised and hidden via `clipped`, not left to
      // float because its segment was simply absent from the map).
      const clipped = far.screenY >= minScreenY;
      const offsets = this.offsetPool[i];
      offsets.nearOffsetX = nearOffsetX;
      offsets.farOffsetX = farOffsetX;
      offsets.clipped = clipped;
      drawnSegments.set(segIndex, offsets);
      if (clipped) {
        clippedSegments.add(segIndex);
        continue;
      }
      minScreenY = far.screenY;
      if (far.screenY < topScreenY) {
        topScreenY = far.screenY;
        farCurveOffset = farOffsetX;
      }

      // Slow, world-anchored snow variation replaces the old short zebra
      // bands. Sixteen cached tones keep it smooth without a color blend/frame.
      const surfaceBand = Math.min(SURFACE_BANDS - 1,
        Math.floor((0.5 + Math.sin(segIndex * 0.085) * 0.5) * SURFACE_BANDS));

      // Aerial perspective. Distant snow loses contrast and drifts toward the
      // colour of the air in front of it — without this the road holds full
      // saturation right up to the point it stops, which is what made the far
      // edge read as a hard seam pasted onto the sky rather than as distance.
      //
      // The ramp is deliberately non-linear: haze accumulates slowly across
      // the near half and then quickly, matching how the eye reads depth. The
      // test is not "can I see haze" but "does a surface at distance still
      // keep its own local contrast" — hence the 0.82 ceiling, which leaves
      // far geometry legible instead of dissolving it into flat fog.
      const colors = this.shades[i * SURFACE_BANDS + surfaceBand];

      // Off-piste fills the full screen width behind the road (unaffected by
      // the curve offset).
      // Off-piste bleeds past both screen edges so a camera shake on impact
      // cannot expose the black page behind the canvas.
      this.fillTrapezoid(
        -SHAKE_BLEED_PX, SCREEN_W + SHAKE_BLEED_PX, near.screenY,
        -SHAKE_BLEED_PX, SCREEN_W + SHAKE_BLEED_PX, far.screenY,
        colors.offPiste
      );

      // Sculpted snow shoulders: their light and shadow make the playable
      // boundary legible without turning the mountain into a striped highway.
      if (i < 45) {
        this.fillTrapezoid(
          near.screenX - near.screenW * SNOWBANK_WIDTH_RATIO,
          near.screenX - near.screenW * EDGE_WIDTH_RATIO, near.screenY,
          far.screenX - far.screenW * SNOWBANK_WIDTH_RATIO,
          far.screenX - far.screenW * EDGE_WIDTH_RATIO, far.screenY,
          colors.bankLit
        );
        this.fillTrapezoid(
          near.screenX + near.screenW * EDGE_WIDTH_RATIO,
          near.screenX + near.screenW * SNOWBANK_WIDTH_RATIO, near.screenY,
          far.screenX + far.screenW * EDGE_WIDTH_RATIO,
          far.screenX + far.screenW * SNOWBANK_WIDTH_RATIO, far.screenY,
          colors.bankShadow
        );
      }

      const surface = colors.snow;
      this.fillTrapezoid(
        near.screenX - near.screenW, near.screenX + near.screenW, near.screenY,
        far.screenX - far.screenW, far.screenX + far.screenW, far.screenY,
        surface
      );

      // Piste markers belong to exact world segments and are rendered after
      // the terrain pass so further snow cannot paint over their raised tops.
      if (segIndex % 12 === 0 && i < 70) {
        const height = far.scale * 340 * (SCREEN_H / 2);
        if (height >= 3) {
          for (let side = -1; side <= 1; side += 2) {
            const marker = this.markers[this.markerCount++];
            marker.x = far.screenX + side * far.screenW * 1.09;
            marker.y = far.screenY;
            marker.height = height;
            marker.width = Math.max(1, far.scale * 22 * (SCREEN_W / 2));
            marker.alpha = 1 - i / (DRAW_DISTANCE * 1.2);
          }
        }
      }

      // Four shallow seams divide the five rideable lanes. These sit on the
      // actual lane boundaries (not the centres), giving a clear dodge/jump
      // corridor without painted road markings or competing with hazards.
      if (i < 36) {
        const seamColor = colors.seam;
        for (let lane = 1; lane < 5; lane++) {
          const edge = lane * 0.4 - 1;
          const nearHalf = Math.max(0.35, near.screenW * 0.0019);
          const farHalf = Math.max(0.25, far.screenW * 0.0019);
          this.fillTrapezoid(
            near.screenX + edge * near.screenW - nearHalf,
            near.screenX + edge * near.screenW + nearHalf, near.screenY,
            far.screenX + edge * far.screenW - farHalf,
            far.screenX + edge * far.screenW + farHalf, far.screenY,
            seamColor
          );
        }
      }

      // Groomer corduroy — the parallel ridges a piste basher leaves. Drawn
      // only for the nearest segments: beyond that the lines fall below a
      // pixel and turn into shimmer, and drawing them the whole way would add
      // ~800 fill paths a frame on top of the existing ~300 for no visible
      // gain. This is a LOD, not a shortcut.
      if (i < CORDUROY_SEGMENTS && segIndex % 2 === 0) {
        const groove = colors.corduroy;
        for (let g = 1; g < CORDUROY_LINES; g++) {
          const t = g / CORDUROY_LINES - 0.5;
          this.fillTrapezoid(
            near.screenX + t * near.screenW * 2 - 1, near.screenX + t * near.screenW * 2 + 1, near.screenY,
            far.screenX + t * far.screenW * 2 - 0.5, far.screenX + t * far.screenW * 2 + 0.5, far.screenY,
            groove
          );
        }
      }
    }

    this.drawMarkers();
    return { clippedSegments, drawnSegments, topScreenY, farCurveOffset };
  }

  private drawMarkers(): void {
    for (let i = this.markerCount - 1; i >= 0; i--) {
      const marker = this.markers[i];
      if (marker.x < -16 || marker.x > SCREEN_W + 16) continue;
      const top = marker.y - marker.height;
      this.graphics.lineStyle(marker.width, SNOW.shadow, marker.alpha);
      this.graphics.lineBetween(marker.x, marker.y, marker.x, top);
      this.graphics.lineStyle(marker.width * 1.5, RUMBLE.warn, marker.alpha);
      this.graphics.lineBetween(marker.x, top, marker.x, top + marker.height * 0.32);
      this.graphics.lineStyle(marker.width, SNOW.packed, marker.alpha);
      this.graphics.lineBetween(marker.x, top + marker.height * 0.32,
        marker.x, top + marker.height * 0.43);
    }
  }

  /** All six depth ramps are stable for a given atmosphere. Cache them
   * instead of creating RGB objects and doing gamma conversions hundreds of
   * times per frame; extra piste detail has no extra colour-math churn. */
  private prepareShades(fogColor: number): void {
    if (fogColor === this.lastFogColor) return;
    this.lastFogColor = fogColor;
    for (let i = 0; i < DRAW_DISTANCE; i++) {
      const fog = Math.min(0.82, Math.pow(i / DRAW_DISTANCE, 1.7) * 1.15);
      for (let band = 0; band < SURFACE_BANDS; band++) {
        const colors = this.shades[i * SURFACE_BANDS + band];
        const variation = band / (SURFACE_BANDS - 1);
        colors.snow = mix(mix(SNOW_LIGHT, SNOW_DARK, variation * 0.32), fogColor, fog);
        colors.offPiste = mix(mix(OFF_PISTE_LIGHT, OFF_PISTE_DARK, variation * 0.42), fogColor, fog);
        colors.bankLit = mix(SNOW.packed, fogColor, fog);
        colors.bankShadow = mix(SNOW.shadow, fogColor, fog);
        colors.seam = mix(colors.snow, SNOW.shadow, 0.22 * Math.max(0, 1 - i / 42));
        colors.corduroy = mix(colors.snow, SNOW.shadow, 0.16 * Math.max(0, 1 - i / CORDUROY_SEGMENTS));
      }
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
