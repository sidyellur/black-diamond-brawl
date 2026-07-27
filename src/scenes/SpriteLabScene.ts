import Phaser from 'phaser';
import { drawRider, RIDER_FRAME_SIZE, RiderPose, PLAYER_RIDER_PALETTE, RIVAL_RIDER_PALETTES } from '../entities/riderArt';
import { drawObstacle, OBSTACLE_ART_SIZE, ObstacleArtKind } from '../entities/obstacleArt';
import { drawPickup, PICKUP_ART_SIZE } from '../entities/pickupArt';
import { MIN_OUTLINE_DELTA_L, SNOW, UI } from '../render/palette';
import { measureOutlineContrast, PixelCanvas } from '../render/pixel';

/**
 * A contact sheet for every generated sprite, reachable at `?spritelab=1`.
 *
 * Shows each sprite at 1x, at 4x for inspecting individual pixels, at the
 * widths the projection actually renders at during play, and as a solid black
 * silhouette. Backed by `scripts/spriteLab.mjs` so the same view runs headless
 * as part of the gate.
 *
 * The silhouette column exists because interior detail is worthless if the
 * shape does not read — and at 24px the shape is essentially all there is.
 */
export class SpriteLabScene extends Phaser.Scene {
  constructor() {
    super({ key: 'SpriteLabScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x18202b);

    const report: Array<{ name: string; outlineDeltaL: number; min: number }> = [];

    const entries: Array<{ name: string; cv: PixelCanvas }> = [];

    const poses: RiderPose[] = ['lean-left', 'center', 'lean-right', 'jump', 'tumble'];
    for (const pose of poses) {
      entries.push({ name: `player/${pose}`, cv: drawRider(pose, PLAYER_RIDER_PALETTE) });
    }
    RIVAL_RIDER_PALETTES.forEach((pal, i) => {
      entries.push({ name: `rival${i}/center`, cv: drawRider('center', pal) });
    });
    const obstacles: ObstacleArtKind[] = ['tree', 'rock', 'mogul'];
    for (const kind of obstacles) {
      entries.push({ name: `obstacle/${kind}`, cv: drawObstacle(kind) });
    }
    entries.push({ name: 'pickup/ski-pole', cv: drawPickup() });

    // Snow strip behind everything — sprites must be judged against the
    // surface they actually sit on, not a neutral grey.
    this.add.rectangle(0, 0, 1280, 4000, SNOW.packed).setOrigin(0, 0).setAlpha(1);

    // Two columns — the canvas is a fixed 540px tall, so a single stacked list
    // of every sprite would run off the bottom and simply not render.
    const COLS = 2;
    const COL_W = 480;
    const ROW_H = 74;
    const perCol = Math.ceil(entries.length / COLS);

    entries.forEach(({ name, cv }, i) => {
      const key = `lab-${name}`;
      this.registerCanvas(key, cv);

      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const ox = 6 + col * COL_W;
      const oy = 18 + row * ROW_H;
      const midY = oy + ROW_H / 2 - 6;

      this.add.text(ox, midY - 6, name, {
        fontSize: '11px',
        color: `#${UI.panel.toString(16).padStart(6, '0')}`
      });

      // The widths the projection actually renders at during play, so a change
      // is judged at the size it will be seen — not at a comfortable zoom.
      let x = ox + 104;
      for (const targetW of [cv.w, 24, 40, 78]) {
        const img = this.add.image(x, midY, key);
        img.setOrigin(0, 0.5);
        img.setDisplaySize(targetW, targetW * (cv.h / cv.w));
        x += targetW + 10;
      }

      // Silhouette: if the solid black shape does not read as its subject,
      // interior shading will not save it once the sprite is scaled down.
      const sil = this.add.image(x, midY, key);
      sil.setOrigin(0, 0.5);
      sil.setDisplaySize(cv.w, cv.h);
      sil.setTintFill(0x000000);

      const contrast = measureOutlineContrast(cv, SNOW.packed);
      report.push({ name, outlineDeltaL: contrast, min: MIN_OUTLINE_DELTA_L });
    });

    (window as unknown as { __spriteLabReport: unknown }).__spriteLabReport = report;
  }

  private registerCanvas(key: string, cv: PixelCanvas): void {
    if (this.textures.exists(key)) return;
    const tex = this.textures.createCanvas(key, cv.w, cv.h);
    if (!tex) return;
    const ctx = tex.getContext();
    const img = ctx.createImageData(cv.w, cv.h);
    img.data.set(cv.data);
    ctx.putImageData(img, 0, 0);
    tex.refresh();
  }
}

export const SPRITE_LAB_FRAME_SIZES = {
  rider: RIDER_FRAME_SIZE,
  obstacle: OBSTACLE_ART_SIZE,
  pickup: PICKUP_ART_SIZE
};
