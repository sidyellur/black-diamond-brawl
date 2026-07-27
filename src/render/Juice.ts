import Phaser from 'phaser';
import { MAX_SPEED, SCREEN_H, SCREEN_W } from '../config';
import { DEPTH } from './depth';
import { FLAKE_KEY, SNOW_PUFF_KEY, SPARK_KEY } from './particleArt';

/**
 * Impact and speed feedback.
 *
 * Before this, a landed combat hit changed a number on the HUD and nothing
 * else — no shake, no flash, no particle, no sound. The rule adopted from the
 * reference project is that every action has weight: an impact should produce
 * a camera impulse, a screen-space effect and a visual transient together, or
 * it does not register as having happened.
 *
 * All emitters live on the world camera only, so the UI camera keeps the HUD
 * still and ungraded while the world shakes.
 */
export class Juice {
  private readonly scene: Phaser.Scene;
  private readonly worldCam: Phaser.Cameras.Scene2D.Camera;

  private spray!: Phaser.GameObjects.Particles.ParticleEmitter;
  private burst!: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private ambient!: Phaser.GameObjects.Particles.ParticleEmitter;

  private speedLines!: Phaser.GameObjects.Graphics;
  private flash!: Phaser.GameObjects.Rectangle;

  /** Frames of hit-stop remaining. A couple of frozen frames on impact is the
   *  cheapest way to make a collision feel like it had mass. */
  private hitStopMs = 0;

  constructor(
    scene: Phaser.Scene,
    worldCam: Phaser.Cameras.Scene2D.Camera,
    register: (obj: Phaser.GameObjects.GameObject) => void
  ) {
    this.scene = scene;
    this.worldCam = worldCam;

    // Snow thrown off the board edge. Low gravity and a short life — powder
    // hangs briefly then drops, it does not arc like debris.
    this.spray = scene.add.particles(0, 0, SNOW_PUFF_KEY, {
      speed: { min: 30, max: 120 },
      angle: { min: 200, max: 340 },
      scale: { start: 0.9, end: 0.15 },
      alpha: { start: 0.75, end: 0 },
      lifespan: { min: 260, max: 620 },
      gravityY: 140,
      frequency: -1,
      blendMode: 'NORMAL'
    });
    this.spray.setDepth(DEPTH.VFX);

    // Collision burst — wider, faster, shorter than the carve spray.
    this.burst = scene.add.particles(0, 0, SNOW_PUFF_KEY, {
      speed: { min: 90, max: 300 },
      angle: { min: 180, max: 360 },
      scale: { start: 1.5, end: 0.2 },
      alpha: { start: 0.95, end: 0 },
      lifespan: { min: 300, max: 780 },
      gravityY: 260,
      frequency: -1
    });
    this.burst.setDepth(DEPTH.VFX);

    this.sparks = scene.add.particles(0, 0, SPARK_KEY, {
      speed: { min: 120, max: 340 },
      angle: { min: 0, max: 360 },
      scale: { start: 1.1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 180, max: 420 },
      frequency: -1,
      blendMode: 'ADD'
    });
    this.sparks.setDepth(DEPTH.VFX);

    // Ambient snowfall. Continuous, slow, and deliberately sparse — enough to
    // give the air some depth without reading as a blizzard.
    this.ambient = scene.add.particles(0, 0, FLAKE_KEY, {
      x: { min: -40, max: SCREEN_W + 40 },
      y: -10,
      speedY: { min: 22, max: 70 },
      speedX: { min: -26, max: 10 },
      scale: { min: 0.5, max: 1.4 },
      alpha: { min: 0.18, max: 0.5 },
      lifespan: 9000,
      frequency: 220,
      quantity: 1
    });
    this.ambient.setDepth(DEPTH.VFX - 1);

    this.speedLines = scene.add.graphics();
    this.speedLines.setDepth(DEPTH.VFX + 1);

    this.flash = scene.add.rectangle(SCREEN_W / 2, SCREEN_H / 2, SCREEN_W * 1.2, SCREEN_H * 1.2, 0xffffff);
    this.flash.setDepth(DEPTH.VFX + 2);
    this.flash.setAlpha(0);

    [this.spray, this.burst, this.sparks, this.ambient, this.speedLines, this.flash].forEach(register);
  }

  /** True while the world should not advance — see `hitStopMs`. */
  get frozen(): boolean {
    return this.hitStopMs > 0;
  }

  tick(deltaMs: number): void {
    if (this.hitStopMs > 0) this.hitStopMs = Math.max(0, this.hitStopMs - deltaMs);
  }

  /** Snow off the board while carving. Rate scales with speed, and hard turns
   *  throw noticeably more — that difference is the visual reward for
   *  committing to a carve. */
  emitCarve(x: number, y: number, speed01: number, leaning: boolean): void {
    if (speed01 < 0.12) return;
    const n = leaning ? 3 : 1;
    if (!leaning && Math.random() > speed01 * 0.75) return;
    this.spray.emitParticleAt(x, y, n);
  }

  /** A collision. `severity` 0..1 scales shake, flash and particle count. */
  impact(x: number, y: number, severity: number): void {
    const s = Math.max(0, Math.min(1, severity));
    this.burst.emitParticleAt(x, y, Math.round(8 + s * 22));
    this.worldCam.shake(90 + s * 210, 0.006 + s * 0.016);
    this.hitStopMs = 40 + s * 90;
    this.flashScreen(s * 0.35);
  }

  /** A landed shove. Sparks plus a short, sharp shake — distinct from a
   *  collision so the two never feel like the same event. */
  combatHit(x: number, y: number): void {
    this.sparks.emitParticleAt(x, y, 12);
    this.burst.emitParticleAt(x, y, 6);
    this.worldCam.shake(110, 0.008);
    this.hitStopMs = 55;
  }

  /** A landed trick. Celebratory, no shake — shaking on a reward would read
   *  as a penalty. */
  trickLanded(x: number, y: number): void {
    this.sparks.emitParticleAt(x, y, 16);
    this.spray.emitParticleAt(x, y, 8);
  }

  private flashScreen(alpha: number): void {
    if (alpha <= 0) return;
    this.flash.setAlpha(alpha);
    this.scene.tweens.add({ targets: this.flash, alpha: 0, duration: 190, ease: 'Quad.easeOut' });
  }

  /**
   * Speed lines and vignette, drawn every frame with intensity tied to
   * current speed. This is what makes the difference between 60% and 100%
   * speed something you feel rather than something you read off the HUD.
   */
  renderSpeed(speed: number, timeMs: number): void {
    const t = Math.max(0, Math.min(1, speed / MAX_SPEED));
    this.speedLines.clear();
    if (t < 0.45) return;

    const strength = (t - 0.45) / 0.55;
    const count = Math.round(strength * 14);
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H * 0.56;

    // Radial streaks from the vanishing point, confined to the periphery.
    // Two constraints matter: they must stay out of the centre, where the
    // player is looking and where nothing should distract, and out of the sky,
    // where a motion streak has nothing to be a streak *of* and just reads as
    // a scratch on the lens. What is left is the lower outer margin — which is
    // where peripheral motion actually registers.
    for (let i = 0; i < count; i++) {
      const seed = (i * 2654435761 + Math.floor(timeMs / 55) * 40503) >>> 0;
      const ang = ((seed % 1000) / 1000) * Math.PI * 2;
      const dist = 0.62 + ((seed >> 10) % 1000) / 1000 * 0.45;
      const len = 18 + strength * 44;
      const r = SCREEN_W * dist * 0.6;
      const x1 = cx + Math.cos(ang) * r;
      const y1 = cy + Math.sin(ang) * r * 0.6;
      if (y1 < SCREEN_H * 0.58) continue; // above the road: skip
      if (Math.abs(x1 - cx) < SCREEN_W * 0.24) continue; // too central: skip
      const x2 = cx + Math.cos(ang) * (r + len);
      const y2 = cy + Math.sin(ang) * (r + len) * 0.6;
      this.speedLines.lineStyle(2, 0xffffff, 0.04 + strength * 0.1);
      this.speedLines.lineBetween(x1, y1, x2, y2);
    }
  }
}
