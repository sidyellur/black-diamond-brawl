import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { SKY, mix } from './palette';
import { generateMountainTextures, MOUNTAIN_LAYERS, SKY_DETAILS_KEY } from './mountainArt';
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

/** Fine enough for a smooth 30px transition, while keeping a single Graphics
 * object and avoiding runtime texture uploads or per-frame colour math. */
const HAZE_STRIPS = 32;

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
const HORIZON_FOG_COLOR = skyColorAt(HORIZON_FRACTION - 0.012);
export function horizonFogColor(): number {
  return HORIZON_FOG_COLOR;
}

/** A few cached texture layers make the mountains richer without rebuilding
 * hundreds of paths every frame. TileSprite wraps in either direction, so a
 * right-hand bend can never scroll the entire range out of view. */
export class SkyRenderer {
  private readonly sky: Phaser.GameObjects.Image;
  private readonly details: Phaser.GameObjects.Image;
  private readonly mountains: Phaser.GameObjects.TileSprite[] = [];
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly hazeColors = Array.from({ length: HAZE_STRIPS }, (_, i) =>
    mix(HORIZON_FOG_COLOR, SKY.murk, (i + 0.5) / (HAZE_STRIPS * 2)));

  constructor(scene: Phaser.Scene) {
    generateMountainTextures(scene);
    this.sky = scene.add.image(SCREEN_W / 2, SCREEN_H / 2, SKY_TEXTURE_KEY);
    this.sky.setDisplaySize(SCREEN_W + 160, SCREEN_H + 96);
    this.sky.setScrollFactor(0);

    this.details = scene.add.image(0, 0, SKY_DETAILS_KEY).setOrigin(0);
    for (const layer of MOUNTAIN_LAYERS) {
      this.mountains.push(scene.add.tileSprite(
        -64, layer.top, SCREEN_W + 128, layer.height, layer.key
      ).setOrigin(0));
    }
    this.graphics = scene.add.graphics();
    this.setDepth(DEPTH.BACKDROP);
  }

  /** Every object must be excluded from the HUD camera. */
  get displayObjects(): Phaser.GameObjects.GameObject[] {
    return [this.sky, this.details, ...this.mountains, this.graphics];
  }

  setDepth(depth: number): void {
    this.sky.setDepth(depth);
    this.details.setDepth(depth + 1);
    this.mountains.forEach((mountain, i) => mountain.setDepth(depth + 2 + i));
    this.graphics.setDepth(depth + 2 + this.mountains.length);
  }

  /** The same curve and lateral-camera parallax used by the road. Clouds and
   * sun stay still, while nearer ridges move more quickly. */
  render(curveOffset: number, camX: number, topScreenY: number): void {
    for (let i = 0; i < this.mountains.length; i++) {
      const layer = MOUNTAIN_LAYERS[i];
      this.mountains[i].tilePositionX =
        curveOffset * layer.parallax + camX * layer.parallax * 0.0009;
    }
    this.graphics.clear();
    this.drawHazeBand(topScreenY);
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
    const bandTop = Math.min(horizonY - 10, topScreenY - 30);
    const bandBottom = Math.max(topScreenY + 2, bandTop + 2);

    // Haze builds toward the measured snow edge, including flat ground where
    // that edge is ABOVE the nominal backdrop horizon. Sample each narrow
    // strip at its midpoint. These translucent rectangles must not overlap:
    // the old +1px bleed composited the haze twice at every boundary and drew
    // bright horizontal scanlines, especially visible at high crests.
    for (let i = 0; i < HAZE_STRIPS; i++) {
      const t0 = i / HAZE_STRIPS;
      const midpoint = (i + 0.5) / HAZE_STRIPS;
      const y0 = bandTop + (bandBottom - bandTop) * t0;
      const y1 = bandTop + (bandBottom - bandTop) * ((i + 1) / HAZE_STRIPS);
      this.graphics.fillStyle(this.hazeColors[i], 0.035 + midpoint * midpoint * 0.96);
      this.graphics.fillRect(-64, y0, SCREEN_W + 128, y1 - y0);
    }
  }
}
