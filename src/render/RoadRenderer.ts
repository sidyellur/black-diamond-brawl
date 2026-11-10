import Phaser from 'phaser';
import { CHUTE_FUNNEL_SEGMENTS, DRAW_DISTANCE, SCREEN_H, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { Segment } from '../track/segment';
import { MountainTheme, themeAtSegment } from '../track/mountain';
import { CHUTE, ICE, RUMBLE, SNOW, mix } from './palette';
import { project, type ProjectedPoint } from './project';

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
const THEMES: readonly MountainTheme[] = ['forest', 'ridge', 'bowl'];
const THEME_INDEX: Record<MountainTheme, number> = { forest: 0, ridge: 1, bowl: 2 };
const BANK_WIDTH: Record<MountainTheme, number> = { forest: 1.13, ridge: 1.08, bowl: 1.72 };
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

/** Powder is read through its stipple: flecks scattered across each segment on
 *  a world-anchored hash (so they scroll with the road and never swim), dense
 *  up close and thinner farther out. Capped for the same sub-pixel reason as
 *  the corduroy, and cheap: one rect each, only while a powder field is in view. */
const POWDER_STIPPLE_SEGMENTS = 44;
/** Flecks per segment by draw slot: the nearest slots cover most of the screen
 *  and need the most; far ones are thin slivers. */
const POWDER_FLECKS_BY_SLOT: readonly [number, number][] = [[3, 70], [8, 46], [18, 30], [32, 18], [44, 10]];

/** Ice is read through long longitudinal scratches and glossy sheen patches,
 *  the opposite of powder's short stippled dashes. The scratches sit on fixed
 *  world-anchored lines across the road, present or absent per segment, so they
 *  run on as dashes of random length and scroll with the road instead of
 *  swimming. Capped like the corduroy: past this they are sub-pixel shimmer. */
const ICE_DETAIL_SEGMENTS = 42;
const ICE_STREAK_LINES = 9;

/** Cheap deterministic hash to [0, 1), render-only (never feeds the simulation). */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b + 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3a5d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

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
  terrain: number;
  powder: number;
  powderSeam: number;
  powderFleck: number;
  powderSpark: number;
  powderEdge: number;
  ice: number;
  iceSeam: number;
  iceStreak: number;
  iceSheen: number;
  iceEdge: number;
  chuteZone: number;
  chuteLine: number;
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
  private readonly shades: SurfaceShades[] = Array.from({ length: DRAW_DISTANCE * SURFACE_BANDS * THEMES.length }, () => ({
    snow: 0, offPiste: 0, bankLit: 0, bankShadow: 0, seam: 0, corduroy: 0, terrain: 0,
    powder: 0, powderSeam: 0, powderFleck: 0, powderSpark: 0, powderEdge: 0,
    ice: 0, iceSeam: 0, iceStreak: 0, iceSheen: 0, iceEdge: 0, chuteZone: 0, chuteLine: 0
  }));
  private readonly markers = Array.from({ length: 20 }, () => ({ x: 0, y: 0, height: 0, width: 0, alpha: 0 }));
  private markerCount = 0;
  /** The funnel's marker poles. A funnel is `CHUTE_FUNNEL_SEGMENTS` long with a pole pair every second segment. */
  private readonly chutePoles = Array.from({ length: 24 }, () => ({ x: 0, y: 0, height: 0, width: 0, alpha: 0 }));
  private chutePoleCount = 0;
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
    this.chutePoleCount = 0;

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
      const theme = themeAtSegment(segment);
      const bankWidth = BANK_WIDTH[theme];
      const colors = this.shades[(THEME_INDEX[theme] * DRAW_DISTANCE + i) * SURFACE_BANDS + surfaceBand];

      // Off-piste fills the full screen width behind the road (unaffected by
      // the curve offset).
      // Off-piste bleeds past both screen edges so a camera shake on impact
      // cannot expose the black page behind the canvas.
      this.fillTrapezoid(
        -SHAKE_BLEED_PX, SCREEN_W + SHAKE_BLEED_PX, near.screenY,
        -SHAKE_BLEED_PX, SCREEN_W + SHAKE_BLEED_PX, far.screenY,
        colors.offPiste
      );

      // Ridge rock faces hug the narrow snow spine; bowl walls curve far
      // outward into a wide amphitheatre. Only scenery changes width: poles,
      // lane centres, road projection and collision still agree exactly.
      if (theme !== 'forest' && i < 55) {
        const outer = theme === 'ridge' ? 2.4 + Math.sin(segIndex * 0.12) * 0.25 : 2.3;
        const inner = theme === 'ridge' ? bankWidth : 1.85;
        for (const side of [-1, 1]) {
          this.fillTrapezoid(
            near.screenX + side * near.screenW * inner,
            near.screenX + side * near.screenW * outer, near.screenY,
            far.screenX + side * far.screenW * inner,
            far.screenX + side * far.screenW * outer, far.screenY,
            colors.terrain
          );
        }
      }

      // Sculpted snow shoulders: their light and shadow make the playable
      // boundary legible without turning the mountain into a striped highway.
      if (i < 45) {
        this.fillTrapezoid(
          near.screenX - near.screenW * bankWidth,
          near.screenX - near.screenW * EDGE_WIDTH_RATIO, near.screenY,
          far.screenX - far.screenW * bankWidth,
          far.screenX - far.screenW * EDGE_WIDTH_RATIO, far.screenY,
          colors.bankLit
        );
        this.fillTrapezoid(
          near.screenX + near.screenW * EDGE_WIDTH_RATIO,
          near.screenX + near.screenW * bankWidth, near.screenY,
          far.screenX + far.screenW * EDGE_WIDTH_RATIO,
          far.screenX + far.screenW * bankWidth, far.screenY,
          colors.bankShadow
        );
      }

      const powder = segment.surface === 'powder';
      const ice = segment.surface === 'ice';
      this.fillTrapezoid(
        near.screenX - near.screenW, near.screenX + near.screenW, near.screenY,
        far.screenX - far.screenW, far.screenX + far.screenW, far.screenY,
        powder ? colors.powder : ice ? colors.ice : colors.snow
      );
      if (powder) this.drawPowder(segIndex, i, near, far, colors, track[(segIndex - 1 + len) % len].surface !== 'powder');
      if (ice) this.drawIce(segIndex, i, near, far, colors, track[(segIndex - 1 + len) % len].surface !== 'ice');
      if (segment.chute || segment.chuteFunnel) this.drawChute(track, segIndex, i, near, far, colors);

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
        const seamColor = powder ? colors.powderSeam : ice ? colors.iceSeam : colors.seam;
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
      if (!powder && !ice && i < CORDUROY_SEGMENTS && segIndex % 2 === 0) {
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
    this.drawChutePoles();
    return { clippedSegments, drawnSegments, topScreenY, farCurveOffset };
  }

  /** The deep-powder look: a soft threshold where the field begins, then
   *  blue-grey flecks and bright sparkles stippled across the road. The groomed
   *  corduroy is dropped and the lane seams softened, so the lanes stay legible
   *  but the surface no longer looks pressed flat. */
  private drawPowder(segIndex: number, i: number, near: ProjectedPoint, far: ProjectedPoint,
    colors: SurfaceShades, threshold: boolean): void {
    if (threshold) {
      // A soft blue drift line across the whole road, one step thick.
      const band = 0.34;
      const farY = near.screenY + (far.screenY - near.screenY) * band;
      const farX = near.screenX + (far.screenX - near.screenX) * band;
      const farW = near.screenW + (far.screenW - near.screenW) * band;
      this.fillTrapezoid(near.screenX - near.screenW, near.screenX + near.screenW, near.screenY,
        farX - farW, farX + farW, farY, colors.powderEdge);
    }
    if (i >= POWDER_STIPPLE_SEGMENTS) return;
    const count = POWDER_FLECKS_BY_SLOT.find(([upTo]) => i < upTo)![1];
    for (let pass = 0; pass < 2; pass++) {
      this.graphics.fillStyle(pass === 0 ? colors.powderFleck : colors.powderSpark);
      for (let k = pass; k < count; k += 2) {
        const u = hash01(segIndex, k * 2 + 1);
        const v = hash01(segIndex + 7919, k * 2 + 2);
        const halfW = near.screenW + (far.screenW - near.screenW) * v;
        const x = near.screenX + (far.screenX - near.screenX) * v + (u * 2 - 1) * halfW * 0.98;
        const y = near.screenY + (far.screenY - near.screenY) * v;
        // Short wind-ripple dashes, wider than tall, so the surface reads as
        // drifted rather than sprinkled with grit.
        const w = Math.max(2, halfW * (pass === 0 ? 0.028 : 0.018) * (0.6 + hash01(segIndex + 31, k) * 0.8));
        this.graphics.fillRect(x - w / 2, y - Math.max(0.5, w * 0.12), w, Math.max(1, w * 0.24));
      }
    }
  }

  /** The glare-ice look: a frozen blue threshold where the sheet begins, then
   *  glossy sheen patches and long scratch marks that run with the road. Lane
   *  seams stay, picked out in the same cold blue, so the lanes remain legible. */
  private drawIce(segIndex: number, i: number, near: ProjectedPoint, far: ProjectedPoint,
    colors: SurfaceShades, threshold: boolean): void {
    const lerpAt = (a: number, b: number, t: number): number => a + (b - a) * t;
    const strip = (u0: number, u1: number, v0: number, v1: number, color: number): void => {
      const nx = lerpAt(near.screenX, far.screenX, v0), fx = lerpAt(near.screenX, far.screenX, v1);
      const nw = lerpAt(near.screenW, far.screenW, v0), fw = lerpAt(near.screenW, far.screenW, v1);
      this.fillTrapezoid(nx + u0 * nw, nx + u1 * nw, lerpAt(near.screenY, far.screenY, v0),
        fx + u0 * fw, fx + u1 * fw, lerpAt(near.screenY, far.screenY, v1), color);
    };
    if (threshold) strip(-1, 1, 0, 0.42, colors.iceEdge);
    if (i >= ICE_DETAIL_SEGMENTS) return;
    // Glossy patches: a sheen band over part of the width on every third segment.
    if (segIndex % 3 === 0) {
      const u0 = hash01(segIndex, 5) * 1.1 - 1;
      strip(u0, u0 + 0.5 + hash01(segIndex, 6) * 0.5, 0.12, 0.34, colors.iceSheen);
    }
    // Scratch marks on fixed lines across the road, light and dark alternating.
    for (let line = 0; line < ICE_STREAK_LINES; line++) {
      if (hash01(segIndex + 4421, line) < 0.46) continue;
      const u = -0.93 + (line + hash01(line, 9)) * (1.86 / ICE_STREAK_LINES);
      const half = Math.max(0.004, 0.011 * (0.6 + hash01(line, 3) * 0.8));
      const v0 = hash01(segIndex + 17, line) * 0.3;
      strip(u - half, u + half, v0, Math.min(1, v0 + 0.55 + hash01(segIndex + 29, line) * 0.45),
        line % 2 === 0 ? colors.iceStreak : colors.iceSheen);
    }
  }

  /** The tree chute (#39). The two outer lanes are shaded and edged with a solid line, so the three rideable
   *  ones read as a corridor between the wall trees; the funnel tapers that shading in over its length and
   *  carries a red-and-white pole pair every second segment, so the narrowing reads from far up the course. */
  private drawChute(track: Segment[], segIndex: number, i: number, near: ProjectedPoint, far: ProjectedPoint,
    colors: SurfaceShades): void {
    const segment = track[segIndex];
    // Narrowing: how much of each half-width is shaded at a segment's near and far edge. Full (0.4) in the walls.
    let cut0 = 0.4;
    let cut1 = 0.4;
    let k = 0;
    if (!segment.chute) {
      while (track[segIndex - k - 1]?.chuteFunnel) k++;
      cut0 = 0.4 * (k / CHUTE_FUNNEL_SEGMENTS);
      cut1 = 0.4 * ((k + 1) / CHUTE_FUNNEL_SEGMENTS);
    }
    for (const side of [-1, 1]) {
      this.fillTrapezoid(
        near.screenX + side * near.screenW, near.screenX + side * near.screenW * (1 - cut0), near.screenY,
        far.screenX + side * far.screenW, far.screenX + side * far.screenW * (1 - cut1), far.screenY,
        colors.chuteZone
      );
      // The edge line: continuous along the walls, and along the taper where the funnel closes in.
      const nearHalf = Math.max(0.5, near.screenW * 0.009);
      const farHalf = Math.max(0.35, far.screenW * 0.009);
      this.fillTrapezoid(
        near.screenX + side * near.screenW * (1 - cut0) - nearHalf, near.screenX + side * near.screenW * (1 - cut0) + nearHalf, near.screenY,
        far.screenX + side * far.screenW * (1 - cut1) - farHalf, far.screenX + side * far.screenW * (1 - cut1) + farHalf, far.screenY,
        colors.chuteLine
      );
    }
    if (i < 70 && (k % 2 === 0 || segment.chute) && this.chutePoleCount + 2 <= this.chutePoles.length &&
        (!segment.chute || !track[segIndex - 1]?.chute)) {
      const height = far.scale * 560 * (SCREEN_H / 2);
      if (height >= 3) {
        for (const side of [-1, 1]) {
          const pole = this.chutePoles[this.chutePoleCount++];
          pole.x = far.screenX + side * far.screenW * (1 - cut1);
          pole.y = far.screenY;
          pole.height = height;
          pole.width = Math.max(1.6, far.scale * 44 * (SCREEN_W / 2));
          pole.alpha = 1 - i / (DRAW_DISTANCE * 1.2);
        }
      }
    }
  }

  private drawChutePoles(): void {
    for (let n = this.chutePoleCount - 1; n >= 0; n--) {
      const pole = this.chutePoles[n];
      if (pole.x < -16 || pole.x > SCREEN_W + 16) continue;
      const top = pole.y - pole.height;
      this.graphics.lineStyle(pole.width, CHUTE.line, pole.alpha);
      this.graphics.lineBetween(pole.x, pole.y, pole.x, top);
      // Two white bands up the pole: a barber-pole stripe, readable at a glance and in greyscale.
      this.graphics.lineStyle(pole.width * 1.15, CHUTE.band, pole.alpha);
      this.graphics.lineBetween(pole.x, top + pole.height * 0.14, pole.x, top + pole.height * 0.34);
      this.graphics.lineBetween(pole.x, top + pole.height * 0.56, pole.x, top + pole.height * 0.76);
    }
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
    for (let themeIndex = 0; themeIndex < THEMES.length; themeIndex++) {
      const theme = THEMES[themeIndex];
      // Preserve the packed-snow palette for hazard contrast in every theme.
      // Only non-colliding terrain changes tint and relief.
      const offPiste = theme === 'ridge' ? mix(OFF_PISTE_LIGHT, SNOW.shadow, 0.32)
        : theme === 'bowl' ? mix(OFF_PISTE_LIGHT, SNOW.shadow, 0.06) : OFF_PISTE_LIGHT;
      const terrain = theme === 'ridge' ? mix(SNOW.shadow, 0x667482, 0.58) : SNOW.shadow;
      for (let i = 0; i < DRAW_DISTANCE; i++) {
        const fog = Math.min(0.82, Math.pow(i / DRAW_DISTANCE, 1.7) * 1.15);
        for (let band = 0; band < SURFACE_BANDS; band++) {
          const colors = this.shades[(themeIndex * DRAW_DISTANCE + i) * SURFACE_BANDS + band];
          const variation = band / (SURFACE_BANDS - 1);
          colors.snow = mix(mix(SNOW_LIGHT, SNOW_DARK, variation * 0.32), fogColor, fog);
          colors.offPiste = mix(mix(offPiste, OFF_PISTE_DARK, variation * 0.42), fogColor, fog);
          colors.bankLit = mix(SNOW.packed, fogColor, fog);
          colors.bankShadow = mix(SNOW.shadow, fogColor, fog);
          colors.terrain = mix(terrain, fogColor, fog);
          colors.seam = mix(colors.snow, SNOW.shadow, 0.22 * Math.max(0, 1 - i / 42));
          colors.corduroy = mix(colors.snow, SNOW.shadow, 0.16 * Math.max(0, 1 - i / CORDUROY_SEGMENTS));
          colors.powder = mix(mix(SNOW.powder, SNOW.powderAlt, variation * 0.45), fogColor, fog);
          colors.powderSeam = mix(colors.powder, SNOW.shadow, 0.09 * Math.max(0, 1 - i / 42));
          colors.powderFleck = mix(SNOW.powderFleck, fogColor, Math.min(0.9, fog * 1.1));
          colors.powderSpark = mix(0xffffff, fogColor, fog);
          colors.powderEdge = mix(mix(SNOW.powder, SNOW.powderFleck, 0.62), fogColor, fog);
          colors.ice = mix(mix(ICE.sheet, ICE.sheetAlt, variation), fogColor, fog);
          colors.iceSeam = mix(colors.ice, ICE.streak, 0.3 * Math.max(0, 1 - i / 42));
          colors.iceStreak = mix(mix(ICE.streak, ICE.sheet, 0.25), fogColor, Math.min(0.9, fog * 1.1));
          colors.iceSheen = mix(ICE.sheen, fogColor, fog);
          colors.iceEdge = mix(ICE.edge, fogColor, fog);
          colors.chuteZone = mix(CHUTE.zone, fogColor, fog);
          colors.chuteLine = mix(CHUTE.line, fogColor, Math.min(0.9, fog * 1.05));
        }
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
