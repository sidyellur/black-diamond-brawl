import Phaser from 'phaser';
import { MAX_SPEED, SCREEN_H, SCREEN_W } from '../config';
import { DEPTH } from './depth';
import { FLAKE_KEY, SNOW_PUFF_KEY, SPARK_KEY } from './particleArt';
import { SNOW, UI } from './palette';

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
  private readonly rings = Array.from({ length: 6 }, () => ({
    x: 0, y: 0, life: 0, duration: 1, radius: 0, color: 0, impact: false
  }));
  private nextRing = 0;
  private carveBudget = 0;
  private lastCarveTime = 0;
  private lastCarveX = 0;
  private motionPhase = 0;
  private lastSpeedTime = 0;
  private readonly leftSpray = { min: 285, max: 345 };
  private readonly rightSpray = { min: 195, max: 255 };
  private readonly straightSpray = { min: 200, max: 340 };

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
      scale: { start: 0.78, end: 0.1 },
      tint: [SNOW.packed, SNOW.offPiste],
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
    for (const ring of this.rings) ring.life = Math.max(0, ring.life - deltaMs);
  }

  /** Snow off the board while carving. Rate scales with speed, and hard turns
   *  throw noticeably more — that difference is the visual reward for
   *  committing to a carve. */
  emitCarve(x: number, y: number, speed01: number, leaning: boolean): void {
    const now = this.scene.time.now;
    const elapsed = this.lastCarveTime === 0 ? 16 : Math.min(40, now - this.lastCarveTime);
    const lateral = x - this.lastCarveX;
    this.lastCarveX = x;
    this.lastCarveTime = now;
    if (speed01 < 0.12) { this.carveBudget = 0; return; }
    // Time-based emission keeps powder density identical at 30/60/144 Hz.
    this.carveBudget += elapsed * (leaning ? 95 : 24) * speed01 / 1000;
    const count = Math.floor(this.carveBudget);
    if (count === 0) return;
    this.carveBudget -= count;
    this.spray.setEmitterAngle(leaning
      ? (lateral < 0 ? this.leftSpray : this.rightSpray)
      : this.straightSpray);
    this.spray.emitParticleAt(x + (leaning ? -Math.sign(lateral) * 12 : 0), y - 3, count);
  }

  /** A collision. `severity` 0..1 scales shake, flash and particle count. */
  impact(x: number, y: number, severity: number): void {
    const s = Math.max(0, Math.min(1, severity));
    this.burst.emitParticleAt(x, y, Math.round(8 + s * 22));
    this.worldCam.shake(90 + s * 210, 0.006 + s * 0.016);
    this.hitStopMs = 40 + s * 90;
    this.flashScreen(s * 0.28);
    this.addRing(x, y, 34 + s * 45, SNOW.shadow, false);
  }

  /** A landed shove. Sparks plus a short, sharp shake — distinct from a
   *  collision so the two never feel like the same event.
   *
   *  `at` is the STRUCK rider's projected position — impact feedback belongs
   *  on the rider who was hit, not the attacker. Pass `null` when the rider
   *  can't be projected this frame (behind the camera, beyond draw distance,
   *  crest-clipped — a knockout event can arrive seconds after the shove,
   *  with the treed rival long out of view): the screen-space feedback,
   *  shake and hit-stop, still plays, but no particles are emitted at a
   *  stale or meaningless position. */
  combatHit(at: { x: number; y: number } | null): void {
    if (at) {
      this.sparks.emitParticleAt(at.x, at.y, 12);
      this.burst.emitParticleAt(at.x, at.y, 6);
      this.addRing(at.x, at.y, 44, UI.accentWarn, true);
    }
    this.worldCam.shake(110, 0.008);
    this.hitStopMs = 55;
  }

  /** A landed trick. Celebratory, no shake — shaking on a reward would read
   *  as a penalty. */
  trickLanded(x: number, y: number): void {
    this.sparks.emitParticleAt(x, y, 16);
    this.spray.emitParticleAt(x, y, 12);
    this.addRing(x, y, 64, UI.accentGood, false);
  }

  private flashScreen(alpha: number): void {
    if (alpha <= 0) return;
    this.scene.tweens.killTweensOf(this.flash);
    this.flash.setAlpha(alpha);
    this.scene.tweens.add({ targets: this.flash, alpha: 0, duration: 190, ease: 'Quad.easeOut' });
  }

  private addRing(x: number, y: number, radius: number, color: number, impact: boolean): void {
    const ring = this.rings[this.nextRing];
    this.nextRing = (this.nextRing + 1) % this.rings.length;
    ring.x = x;
    ring.y = y;
    ring.radius = radius;
    ring.color = color;
    ring.impact = impact;
    ring.duration = impact ? 210 : 290;
    ring.life = ring.duration;
  }

  /** Peripheral snow rush moves continuously toward the rider instead of
   * reseeding every 55 ms. Nothing crosses the central obstacle-reading area.
   * Local impact marks share this one Graphics object and a fixed-size pool. */
  renderSpeed(speed: number, timeMs: number): void {
    const t = Math.max(0, Math.min(1, speed / MAX_SPEED));
    const elapsed = this.lastSpeedTime === 0 ? 0 : Math.min(50, timeMs - this.lastSpeedTime);
    this.lastSpeedTime = timeMs;
    this.motionPhase = (this.motionPhase + elapsed * (0.00035 + t * 0.0011)) % 1;
    this.speedLines.clear();

    if (t > 0.45) {
      const strength = (t - 0.45) / 0.55;
      const cx = SCREEN_W / 2;
      const cy = SCREEN_H * 0.52;
      for (let i = 0; i < 14; i++) {
        const phase = (this.motionPhase + i * 0.173) % 1;
        const side = i % 2 === 0 ? -1 : 1;
        const spread = 0.76 + (i % 5) * 0.09;
        const distance = 0.62 + phase * 0.47;
        const dx = side * SCREEN_W * 0.5 * spread;
        const dy = SCREEN_H * (0.25 + (i % 4) * 0.08);
        const length = 0.035 + strength * 0.085;
        const alpha = Math.sin(phase * Math.PI) * strength * 0.3;
        this.speedLines.lineStyle(i % 3 === 0 ? 2 : 1, SNOW.packed, alpha);
        this.speedLines.lineBetween(
          cx + dx * distance, cy + dy * distance,
          cx + dx * (distance + length), cy + dy * (distance + length)
        );
      }
    }

    for (const ring of this.rings) {
      if (ring.life <= 0) continue;
      const progress = 1 - ring.life / ring.duration;
      const radius = ring.radius * (0.25 + progress * 0.75);
      const alpha = (1 - progress) * 0.8;
      this.speedLines.lineStyle(3 * (1 - progress) + 1, ring.color, alpha);
      if (ring.impact) {
        // Eight sharp comic-book ticks make a hit unmistakable against snow.
        for (let i = 0; i < 8; i++) {
          const angle = i * Math.PI / 4;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          this.speedLines.lineBetween(
            ring.x + dx * radius * 0.64, ring.y + dy * radius * 0.64,
            ring.x + dx * radius, ring.y + dy * radius
          );
        }
      } else {
        this.speedLines.strokeEllipse(ring.x, ring.y, radius * 2, radius * 0.48);
        this.speedLines.lineStyle(1, SNOW.packed, alpha * 0.8);
        this.speedLines.strokeEllipse(ring.x, ring.y - 1, radius * 1.85, radius * 0.4);
      }
    }
  }
}
