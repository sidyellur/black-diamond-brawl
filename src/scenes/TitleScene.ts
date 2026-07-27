import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { DEPTH } from '../render/depth';
import { SkyRenderer } from '../render/SkyRenderer';
import { UI } from '../render/palette';
import { resolveSeed } from '../track/seed';
import { drawRider } from '../entities/riderArt';
import { PixelCanvas, registerTexture } from '../render/pixel';
import { PLAYER_RIDER_PALETTE, RIVAL_RIDER_PALETTES } from '../entities/riderArt';

const hex = (v: number): string => `#${v.toString(16).padStart(6, '0')}`;

/**
 * Title screen.
 *
 * Uses the same generated sky and mountain range the race does, so the first
 * frame the player sees is the game's actual look rather than a flat colour
 * with text on it. A row of riders across the slope shows what they are about
 * to control.
 */
export class TitleScene extends Phaser.Scene {
  private seed = 0;
  private sky!: SkyRenderer;
  private drift = 0;

  constructor() {
    super({ key: 'TitleScene' });
  }

  create(): void {
    this.seed = resolveSeed();
    this.drift = 0;

    this.sky = new SkyRenderer(this);

    // Slope beneath the ridges — a simple wedge rather than the full segment
    // renderer, which would need a track, a camera and an update loop for a
    // backdrop nobody plays on.
    const slope = this.add.graphics();
    slope.setDepth(DEPTH.ROAD);
    const horizon = SCREEN_H * 0.62;
    slope.fillStyle(0xbfd2e8, 1);
    slope.fillRect(-40, horizon, SCREEN_W + 80, SCREEN_H - horizon);
    slope.fillStyle(0xeef4fb, 1);
    slope.beginPath();
    slope.moveTo(SCREEN_W * 0.5 - 40, horizon);
    slope.lineTo(SCREEN_W * 0.5 + 40, horizon);
    slope.lineTo(SCREEN_W + 260, SCREEN_H);
    slope.lineTo(-260, SCREEN_H);
    slope.closePath();
    slope.fillPath();

    this.addRiders();
    this.addTitle();

    this.input.keyboard?.once('keydown', () => {
      this.scene.start('RaceScene', { seed: this.seed });
    });
  }

  private addRiders(): void {
    const palettes = [RIVAL_RIDER_PALETTES[0], PLAYER_RIDER_PALETTE, RIVAL_RIDER_PALETTES[2]];
    const xs = [SCREEN_W * 0.3, SCREEN_W * 0.5, SCREEN_W * 0.7];
    const scales = [1.6, 2.4, 1.6];
    palettes.forEach((pal, i) => {
      const key = `title-rider-${i}`;
      if (!this.textures.exists(key)) {
        const cv: PixelCanvas = drawRider(i === 1 ? 'center' : i === 0 ? 'lean-right' : 'lean-left', pal);
        registerTexture(this, key, cv);
      }
      const spr = this.add.image(xs[i], SCREEN_H * 0.86, key);
      spr.setOrigin(0.5, 1);
      spr.setScale(scales[i]);
      spr.setDepth(DEPTH.PLAYER - i);
    });
  }

  private addTitle(): void {
    // An 8-way synthesized outline rather than an offset drop shadow: an
    // offset shadow implies a light direction, and whichever one it picks will
    // fight the scene's own sun. A symmetric ring reads as a drawn outline and
    // is direction-free.
    const label = 'BLACK DIAMOND BRAWL';
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H * 0.24;
    const style = { fontSize: '44px', fontStyle: 'bold', color: hex(UI.panel) };

    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      this.add
        .text(cx + Math.cos(ang) * 3, cy + Math.sin(ang) * 3, label, style)
        .setOrigin(0.5)
        .setDepth(DEPTH.HUD - 1);
    }
    this.add
      .text(cx, cy, label, { ...style, color: hex(UI.inkHigh) })
      .setOrigin(0.5)
      .setDepth(DEPTH.HUD);

    this.add
      .text(cx, cy + 38, 'downhill combat racing', {
        fontSize: '16px',
        color: hex(UI.accentWarn)
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.HUD);

    this.add
      .text(cx, SCREEN_H * 0.93, 'press any key to drop in', {
        fontSize: '18px',
        color: hex(UI.panel),
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.HUD);

    this.add
      .text(SCREEN_W - 12, SCREEN_H - 10, `seed ${this.seed}`, {
        fontSize: '12px',
        color: hex(UI.inkLow)
      })
      .setOrigin(1, 1)
      .setDepth(DEPTH.HUD);
  }

  update(_time: number, delta: number): void {
    // The range drifts slowly so the screen is alive without anything moving
    // fast enough to distract from the title.
    this.drift += delta * 0.9;
    this.sky.render(this.drift, 0, SCREEN_H * 0.62);
  }
}
