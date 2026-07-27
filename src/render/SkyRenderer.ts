import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { MOUNTAIN, SKY, mix, scaleLight } from './palette';
import { DEPTH } from './depth';

/**
 * Sky, sun, and parallax ridges — everything behind the road.
 *
 * The gradient is analytic rather than a hand-picked stop list. Zenith to
 * horizon is a *saturation collapse*, not a hue rotation: the sky does not
 * slide from blue to white, it loses its blue as the air column deepens.
 * Modelling it as per-channel extinction through an airmass reproduces that,
 * including the fact that the change is far from linear — most of the visible
 * variation is packed into the bottom ~20 degrees, which is exactly the part a
 * naive evenly-spaced gradient renders as a flat wash.
 *
 * The sky is baked once into a texture at boot rather than being re-filled
 * every frame. It only depends on screen height, so redrawing several hundred
 * gradient bands per frame would be pure waste.
 */

const SKY_TEXTURE_KEY = 'sky-gradient';

/** Per-channel extinction coefficients. Blue is scattered out of the beam far
 *  more strongly than red, which is the whole reason the sky is blue overhead
 *  and pale at the horizon. */
const BETA = { r: 0.046, g: 0.109, b: 0.265 } as const;

/** Fraction of screen height the horizon sits at. The road's own vanishing
 *  point is SCREEN_H/2; the sky is generated to run well past it so the haze
 *  band always has gradient underneath it however the terrain moves. */
const HORIZON_FRACTION = 0.62;

/**
 * Builds the sky gradient texture. Called once from `BootScene`; no-ops if it
 * already exists, matching the convention the sprite generators use.
 */
export function generateSkyTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(SKY_TEXTURE_KEY)) {
    return;
  }

  const h = SCREEN_H;
  const tex = scene.textures.createCanvas(SKY_TEXTURE_KEY, 1, h);
  if (!tex) {
    return;
  }
  const ctx = tex.getContext();

  for (let y = 0; y < h; y++) {
    ctx.fillStyle = `#${skyColorAt(y / h).toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, y, 1, 1);
  }

  tex.refresh();
}

/**
 * Sky colour at a normalised screen height (0 = top of screen, 1 = bottom).
 * Exported so the fog can sample the same curve the sky is drawn from —
 * sampling fog from the sky itself is what makes distance read as a shift in
 * colour temperature instead of a grey wash laid over everything.
 */
export function skyColorAt(screenFraction: number): number {
  // Elevation angle above the horizon, 0..1. Below the horizon we clamp — the
  // road covers that region anyway.
  const elevation = Math.max(0, (HORIZON_FRACTION - screenFraction) / HORIZON_FRACTION);

  // Airmass: how much atmosphere the eye looks through. Grows sharply toward
  // the horizon. The +0.15 floor stops it running to infinity at elevation 0.
  const airmass = 1 / (elevation + 0.15);

  const ch = (beta: number): number => 255 * (1 - Math.exp(-beta * airmass));
  const base =
    ((Math.round(ch(BETA.r)) << 16) | (Math.round(ch(BETA.g)) << 8) | Math.round(ch(BETA.b))) >>> 0;

  // Tint the analytic result toward the authored palette so the sky belongs to
  // the same colour system as everything else, then add the tight bright band
  // that hugs the horizon (a ~2 degree e-fold, much sharper than the main
  // gradient — this is the thing that makes a horizon look like a horizon
  // rather than the bottom of a gradient).
  const tinted = mix(base, SKY.mid, 0.42);
  const murk = Math.exp(-elevation * 9.5);
  return mix(tinted, SKY.murk, murk * 0.72);
}

/** Fog colour for geometry at the far plane — sampled from the sky right at
 *  the horizon, so distant snow converges on the air in front of it. */
export function horizonFogColor(): number {
  return skyColorAt(HORIZON_FRACTION - 0.012);
}

interface Ridge {
  /** 0 = furthest. Drives colour, height and parallax rate together. */
  depth: number;
  colour: number;
  capColour: number;
  baseY: number;
  amplitude: number;
  /** Horizontal world-units-to-pixels parallax rate. */
  parallax: number;
  points: number[];
}

/**
 * Draws the sky, sun and parallax mountain ridges.
 *
 * Ridge silhouettes are generated once from a seeded value-noise walk so they
 * are stable frame to frame, then scrolled horizontally. Nearer ridges are
 * darker, taller and move faster; each is also blended toward the horizon
 * colour by its own depth, which is the aerial perspective that makes them sit
 * *behind* the slope instead of stickered onto it.
 */
export class SkyRenderer {
  private readonly sky: Phaser.GameObjects.Image;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly ridges: Ridge[] = [];

  constructor(scene: Phaser.Scene) {
    // Stretched from a 1px-wide gradient strip. Oversized horizontally so a
    // camera shake cannot pull its edge into frame.
    this.sky = scene.add.image(SCREEN_W / 2, SCREEN_H / 2, SKY_TEXTURE_KEY);
    this.sky.setDisplaySize(SCREEN_W + 160, SCREEN_H);
    this.sky.setDepth(DEPTH.BACKDROP);
    this.sky.setScrollFactor(0);

    this.graphics = scene.add.graphics();
    this.graphics.setDepth(DEPTH.BACKDROP + 1);

    this.buildRidges();
  }

  /** Deterministic ridge silhouettes. A fixed seed keeps the skyline identical
   *  across runs and restarts — a mountain range that reshuffled every race
   *  would read as noise rather than as a place. */
  private buildRidges(): void {
    const horizonY = SCREEN_H * HORIZON_FRACTION;
    const specs = [
      { depth: 0, colour: MOUNTAIN.far, cap: MOUNTAIN.capFar, lift: 96, amp: 34, para: 0.012, step: 46 },
      { depth: 1, colour: MOUNTAIN.mid, cap: MOUNTAIN.capMid, lift: 66, amp: 30, para: 0.026, step: 34 },
      { depth: 2, colour: MOUNTAIN.near, cap: MOUNTAIN.capNear, lift: 40, amp: 24, para: 0.045, step: 26 }
    ];

    specs.forEach((s, layer) => {
      // Value noise: random heights at fixed intervals, smoothly interpolated.
      // Two octaves is enough for a believable skyline — more just produces
      // spiky visual noise at this scale.
      let seed = 0x9e37 + layer * 0x2545;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const span = SCREEN_W * 2 + 400; // wide enough to scroll without repeating visibly
      const count = Math.ceil(span / s.step) + 3;
      const heights: number[] = [];
      for (let i = 0; i < count; i++) {
        heights.push(rnd() * s.amp + rnd() * s.amp * 0.5);
      }

      const points: number[] = [];
      for (let i = 0; i < count; i++) {
        points.push(-200 + i * s.step, horizonY - s.lift - heights[i]);
      }

      this.ridges.push({
        depth: s.depth,
        // Fade each ridge toward the horizon by its distance. Doing this here
        // rather than picking three arbitrary greys means the range recedes
        // correctly whatever the sky is doing.
        colour: mix(s.colour, horizonFogColor(), 0.55 - layer * 0.16),
        capColour: mix(s.cap, horizonFogColor(), 0.5 - layer * 0.15),
        baseY: horizonY + 8,
        amplitude: s.amp,
        parallax: s.para,
        points
      });
    });
  }

  /** Every display object this renderer owns, so a UI camera can ignore
   *  them. A second camera renders the whole display list unless told
   *  otherwise, and anything left unregistered gets repainted over the top
   *  of the world. */
  get displayObjects(): Phaser.GameObjects.GameObject[] {
    return [this.sky, this.graphics];
  }

  setDepth(depth: number): void {
    this.sky.setDepth(depth);
    this.graphics.setDepth(depth + 1);
  }

  /**
   * @param curveOffset accumulated curve offset at the far end of the road —
   *   swings the ridges with the bend.
   * @param camX camera lateral position, for the smaller shift from lane changes.
   * @param topScreenY where the road actually stops this frame; the haze band
   *   is drawn down to here so there is never a gap between snow and sky.
   */
  render(curveOffset: number, camX: number, topScreenY: number): void {
    this.graphics.clear();

    this.drawSun();

    for (const ridge of this.ridges) {
      // Both the bend and the camera's own lateral position push the range
      // sideways, scaled by depth so far ridges barely move.
      const shift = -(curveOffset * ridge.parallax + camX * ridge.parallax * 0.0009);
      this.drawRidge(ridge, shift);
    }

    this.drawHazeBand(topScreenY);
  }

  private drawSun(): void {
    const x = SCREEN_W * 0.74;
    const y = SCREEN_H * 0.17;

    // Aureole: a wide, fast-falling halo. Drawn as a handful of nested discs
    // rather than a true radial gradient because Graphics has no gradient
    // fill; the falloff exponent matters far more than the step count.
    for (let i = 6; i >= 1; i--) {
      const t = i / 6;
      this.graphics.fillStyle(SKY.sunGlow, 0.055 * Math.pow(1 - t, 1.3) + 0.012);
      this.graphics.fillCircle(x, y, 26 + t * 128);
    }
    this.graphics.fillStyle(SKY.sun, 0.95);
    this.graphics.fillCircle(x, y, 21);
    this.graphics.fillStyle(scaleLight(SKY.sun, 1.4), 1);
    this.graphics.fillCircle(x, y, 15);
  }

  private drawRidge(ridge: Ridge, shiftX: number): void {
    const pts = ridge.points;
    // Wrap the scroll so the range never runs out of geometry.
    const span = pts[pts.length - 2] - pts[0];
    let dx = shiftX % span;
    if (dx > 0) dx -= span;

    this.graphics.fillStyle(ridge.colour, 1);
    this.graphics.beginPath();
    this.graphics.moveTo(pts[0] + dx, ridge.baseY);
    for (let i = 0; i < pts.length; i += 2) {
      this.graphics.lineTo(pts[i] + dx, pts[i + 1]);
    }
    this.graphics.lineTo(pts[pts.length - 2] + dx, ridge.baseY);
    this.graphics.closePath();
    this.graphics.fillPath();

    // Snowcaps: a short bright run just below each local peak. Only the
    // sunward side catches light, which is what keeps the range from looking
    // like a row of identical triangles.
    this.graphics.fillStyle(ridge.capColour, 1);
    for (let i = 2; i < pts.length - 2; i += 2) {
      const prev = pts[i - 1];
      const cur = pts[i + 1];
      const next = pts[i + 3];
      if (cur < prev && cur < next) {
        const x = pts[i] + dx;
        const capH = Math.min(13, (Math.min(prev, next) - cur) * 0.85);
        if (capH < 3) continue;
        this.graphics.beginPath();
        this.graphics.moveTo(x, cur);
        this.graphics.lineTo(x - capH * 0.78, cur + capH);
        this.graphics.lineTo(x + capH * 0.6, cur + capH);
        this.graphics.closePath();
        this.graphics.fillPath();
      }
    }
  }

  /**
   * Fills from the mountain bases down to wherever the snow actually starts.
   *
   * This band is what removes the hard seam the road used to end on. Because
   * it is drawn to the road's *measured* top edge rather than to a fixed
   * horizon, it closes the gap on flat ground, over a crest, and mid-climb
   * alike — the three cases where a constant horizon line falls apart.
   */
  private drawHazeBand(topScreenY: number): void {
    const horizonY = SCREEN_H * HORIZON_FRACTION;
    const fog = horizonFogColor();
    const bandTop = horizonY - 10;
    const bandBottom = Math.max(topScreenY + 2, bandTop + 2);

    // A few stacked strips fading out downward, so the join to the snow is a
    // gradient rather than a line.
    const strips = 7;
    for (let i = 0; i < strips; i++) {
      const t0 = i / strips;
      const y0 = bandTop + (bandBottom - bandTop) * t0;
      const y1 = bandTop + (bandBottom - bandTop) * ((i + 1) / strips);
      this.graphics.fillStyle(mix(fog, SKY.murk, t0 * 0.5), 1 - t0 * 0.15);
      this.graphics.fillRect(-64, y0, SCREEN_W + 128, y1 - y0 + 1);
    }
  }
}
