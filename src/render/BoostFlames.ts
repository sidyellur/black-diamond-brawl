import Phaser from 'phaser';
import { DEPTH } from './depth';
import { FLAME_KEYS, FLAME_TONGUE_H, FLAME_TONGUE_W } from './flameArt';
import { FlameState, type FlameEdge } from './flameState';
import { SNOW_PUFF_KEY, SPARK_KEY } from './particleArt';

/**
 * Over-the-top rocket flames for the boost. Presentation only: it reads `boost.active` and the
 * rider's screen position and never touches the simulation.
 *
 * Two jets sit under the ends of the board and throw flame down the screen, toward the camera,
 * which is where "behind the rider" is in this view. Each jet is a baked flame tongue (white-yellow
 * core, orange body, red rim and tip) with a shorter white core over it. Around them:
 *   - flame-tail blobs, embers and a dark smoke trail,
 *   - a warm glow under (and a faint one over) the rider,
 *   - a scorch streak on the snow behind each jet that fades in about half a second,
 *   - an ignition burst (flash, ring, ember shower, an extra-large first flame) and a flame-out puff.
 * Snow is nearly white, so the flames use ordinary blending: additive light would vanish on it.
 *
 * Cost: one fixed pool of images created up front, no allocation per frame, and `update` returns at
 * once (with everything hidden) while boost is off and the last particle has died.
 * Reduced motion: two steady flames and a steady glow, with no flicker, embers, smoke, scorch,
 * flash or ring.
 */

export interface FlameFrame {
  /** Rider sprite position (bottom-centre origin) and its on-screen width, in game units. */
  x: number;
  y: number;
  width: number;
  /** 0..1 of top speed. */
  speed01: number;
  /** -1, 0, 1: the carve the rider is leaning into. */
  lean: number;
  airborne: boolean;
}

export const FLAME_POOLS = { blobs: 64, embers: 40, smoke: 24, scorch: 18, rings: 2 } as const;

const BLOB_COLORS = buildRamp([0xffe27a, 0xffa02a, 0xf0520c, 0xb0260e, 0x4c2826], 12);
const EMBER_COLORS = buildRamp([0xffc440, 0xff7a18, 0xe03a10, 0x8a2010], 10);
const SMOKE_COLORS = buildRamp([0x8a7468, 0x6c6872, 0x9aa4b2], 8);
const SCORCH_COLORS = buildRamp([0xffc04a, 0xe85a18, 0x7a3a28, 0x3c3438], 12);
const WARM_TINT = 0xffd8b8;

function buildRamp(stops: number[], steps: number): Uint32Array {
  const out = new Uint32Array(steps);
  for (let i = 0; i < steps; i++) {
    const f = (i / (steps - 1)) * (stops.length - 1);
    const a = stops[Math.min(stops.length - 1, Math.floor(f))], b = stops[Math.min(stops.length - 1, Math.floor(f) + 1)];
    const k = f - Math.floor(f);
    const ch = (s: number): number => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
    out[i] = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  }
  return out;
}
const pick = (ramp: Uint32Array, t: number): number => ramp[Math.min(ramp.length - 1, Math.max(0, Math.floor(t * ramp.length)))];

/** Fixed-size particle pool: parallel typed arrays plus the images they drive. */
class Pool {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly s0: Float32Array;
  readonly s1: Float32Array;
  readonly images: Phaser.GameObjects.Image[] = [];
  alive = 0;
  private cursor = 0;

  constructor(scene: Phaser.Scene, key: string, readonly count: number, depth: number, register: (o: Phaser.GameObjects.GameObject) => void, readonly texW: number) {
    this.x = new Float32Array(count); this.y = new Float32Array(count);
    this.vx = new Float32Array(count); this.vy = new Float32Array(count);
    this.age = new Float32Array(count); this.life = new Float32Array(count).fill(1);
    this.s0 = new Float32Array(count); this.s1 = new Float32Array(count);
    this.age.fill(1);
    for (let i = 0; i < count; i++) {
      const image = scene.add.image(0, 0, key).setDepth(depth).setVisible(false);
      register(image);
      this.images.push(image);
    }
  }

  /** Takes a free slot, or the next one round-robin when the pool is full. */
  spawn(x: number, y: number, vx: number, vy: number, life: number, s0: number, s1: number): void {
    let slot = -1;
    for (let n = 0; n < this.count; n++) {
      const i = (this.cursor + n) % this.count;
      if (this.age[i] >= this.life[i]) { slot = i; break; }
    }
    if (slot < 0) slot = this.cursor;
    else this.alive++;
    this.cursor = (slot + 1) % this.count;
    this.x[slot] = x; this.y[slot] = y; this.vx[slot] = vx; this.vy[slot] = vy;
    this.age[slot] = 0; this.life[slot] = life; this.s0[slot] = s0; this.s1[slot] = s1;
    this.images[slot].setVisible(true);
  }

  kill(i: number): void {
    this.age[i] = this.life[i];
    this.images[i].setVisible(false);
    this.alive--;
  }

  hideAll(): void {
    for (let i = 0; i < this.count; i++) { this.age[i] = this.life[i]; this.images[i].setVisible(false); }
    this.alive = 0;
  }
}

export class BoostFlames {
  readonly state = new FlameState();
  private readonly tongues: Phaser.GameObjects.Image[] = [];
  private readonly cores: Phaser.GameObjects.Image[] = [];
  private readonly tongueVariant: number[] = [-1, -1, -1, -1, -1, -1];
  private readonly hot: Phaser.GameObjects.Image[] = [];
  private readonly halo: Phaser.GameObjects.Image;
  private readonly topGlow: Phaser.GameObjects.Image;
  private readonly flash: Phaser.GameObjects.Image;
  private readonly ringImages: Phaser.GameObjects.Image[] = [];
  private readonly ringAge = new Float32Array(FLAME_POOLS.rings).fill(1);
  private readonly ringLife = 380;
  private readonly ringX = new Float32Array(FLAME_POOLS.rings);
  private readonly ringY = new Float32Array(FLAME_POOLS.rings);
  private readonly ringSize = new Float32Array(FLAME_POOLS.rings);
  private flashAge = 1;
  private readonly flashLife = 170;
  private readonly blobs: Pool;
  private readonly embers: Pool;
  private readonly smoke: Pool;
  private readonly scorch: Pool;
  private readonly budget = new Float32Array(2);
  private scorchClock = 0;
  private clock = 0;
  private shown = false;
  private rng = 0x2f6e2b1;
  /** Warm tint for the rider sprite while boosting; 0xffffff when not. */
  riderTint = 0xffffff;

  constructor(scene: Phaser.Scene, register: (obj: Phaser.GameObjects.GameObject) => void, private readonly reducedMotion: boolean) {
    const under = DEPTH.PLAYER - 1;
    this.scorch = new Pool(scene, FLAME_KEYS.streak, FLAME_POOLS.scorch, DEPTH.PLAYER - 4, register, 10);
    this.smoke = new Pool(scene, SNOW_PUFF_KEY, FLAME_POOLS.smoke, DEPTH.PLAYER - 3, register, 16);
    this.halo = scene.add.image(0, 0, FLAME_KEYS.glow).setDepth(DEPTH.PLAYER - 2).setVisible(false).setTint(0xff7a24);
    this.blobs = new Pool(scene, FLAME_KEYS.glow, FLAME_POOLS.blobs, under, register, 64);
    // Per jet: a main tongue plus a shorter one on each side, so each jet is a licking cluster.
    for (let j = 0; j < 6; j++) {
      this.tongues.push(scene.add.image(0, 0, FLAME_KEYS.tongueA).setOrigin(0.5, 0).setDepth(under).setVisible(false));
    }
    for (let j = 0; j < 2; j++) {
      this.cores.push(scene.add.image(0, 0, FLAME_KEYS.core).setOrigin(0.5, 0).setDepth(under).setVisible(false));
    }
    for (let j = 0; j < 2; j++) {
      this.hot.push(scene.add.image(0, 0, FLAME_KEYS.glow).setDepth(under).setVisible(false).setTint(0xfff2b4));
    }
    this.topGlow = scene.add.image(0, 0, FLAME_KEYS.glow).setDepth(DEPTH.PLAYER + 1).setVisible(false).setTint(0xff8a2a).setBlendMode(Phaser.BlendModes.ADD);
    this.embers = new Pool(scene, SPARK_KEY, FLAME_POOLS.embers, DEPTH.VFX, register, 8);
    this.flash = scene.add.image(0, 0, FLAME_KEYS.glow).setDepth(DEPTH.VFX).setVisible(false).setTint(0xfff1b8);
    for (let i = 0; i < FLAME_POOLS.rings; i++) {
      this.ringImages.push(scene.add.image(0, 0, FLAME_KEYS.ring).setDepth(DEPTH.VFX).setVisible(false).setTint(0xff9a28));
    }
    [this.halo, this.topGlow, this.flash, ...this.tongues, ...this.cores, ...this.hot, ...this.ringImages].forEach(register);
  }

  private rand(): number {
    // xorshift32: deterministic, allocation-free, and nothing the simulation ever reads.
    let s = this.rng;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.rng = s >>> 0;
    return this.rng / 4294967296;
  }
  private between(a: number, b: number): number { return a + (b - a) * this.rand(); }

  /** Call once per rendered frame with the player's screen pose. Does nothing when there is nothing to draw. */
  update(deltaMs: number, boosting: boolean, f: FlameFrame): void {
    const dt = Math.min(50, Math.max(0, deltaMs));
    this.state.update(dt, boosting, f.airborne);
    if (this.state.edge !== 'none') this.onEdge(this.state.edge, f);
    const live = this.state.lit || this.blobs.alive + this.embers.alive + this.smoke.alive + this.scorch.alive > 0 || this.flashAge < this.flashLife || this.ringAge[0] < this.ringLife || this.ringAge[1] < this.ringLife;
    if (!live) {
      if (this.shown) this.hideAll();
      this.riderTint = 0xffffff;
      return;
    }
    this.shown = true;
    this.clock += dt;
    this.drawTongues(f);
    if (!this.reducedMotion) {
      this.emit(dt, f);
      this.stepBlobs(dt);
      this.stepEmbers(dt);
      this.stepSmoke(dt);
      this.stepScorch(dt, f);
      this.stepIgnition(dt);
    }
    this.drawGlow(f);
  }

  /** Warm the rider while boosting without hiding the suit: a light multiply, not a fill. */
  private warmTint(power: number): number {
    if (power <= 0) return 0xffffff;
    const k = Math.min(1, power);
    const g = Math.round(255 + ((WARM_TINT >> 8 & 255) - 255) * k);
    const b = Math.round(255 + ((WARM_TINT & 255) - 255) * k);
    return (255 << 16) | (g << 8) | b;
  }

  private nozzle(j: number, f: FlameFrame, out: { x: number; y: number }): void {
    out.x = f.x + (j * 0.27 - f.lean * 0.03) * f.width;
    out.y = f.y - f.width * 0.125 + j * f.lean * f.width * 0.045;
  }
  private readonly nz = { x: 0, y: 0 };

  private drawTongues(f: FlameFrame): void {
    const s = this.state;
    const power = s.power;
    const calm = this.reducedMotion;
    const t = this.clock;
    for (let k = 0; k < 2; k++) {
      const j = k === 0 ? -1 : 1;
      this.nozzle(j, f, this.nz);
      const flick = calm ? 1 : 1 + 0.09 * Math.sin(t * 0.045 + j * 1.7) + 0.05 * Math.sin(t * 0.113 + j * 0.6);
      // A sputtering flame (boost cut on takeoff) stutters on and off as it dies.
      const stutter = !calm && s.isSputtering ? 0.5 + 0.5 * Math.abs(Math.sin(t * 0.045 + j)) : 1;
      const length = f.width * (0.72 + 0.5 * f.speed01) * Math.pow(power, 0.8) * (1 + 0.8 * s.burst) * flick * stutter;
      const width = f.width * 0.46 * (0.7 + 0.3 * power) * (1 + 0.4 * s.burst);
      // The jets splay outward into a V, and the whole thing swings against the carve.
      const angle = f.lean * 16 - j * 28 + (calm ? 0 : Math.sin(t * 0.03 + j) * 2.4);
      const core = this.cores[k];
      for (let m = 0; m < 3; m++) {
        const n = k * 3 + m;
        const tongue = this.tongues[n];
        // Side tongues are shorter, thinner and flicker out of step with the main one.
        const side = m === 0 ? 0 : m === 1 ? -1 : 1;
        const lenK = m === 0 ? 1 : (calm ? 0.62 : 0.5 + 0.2 * Math.sin(t * 0.06 + n * 2.1));
        const variant = calm ? 0 : (Math.floor(t / 70) + n) & 1;
        if (this.tongueVariant[n] !== variant) {
          tongue.setTexture(variant === 0 ? FLAME_KEYS.tongueA : FLAME_KEYS.tongueB);
          this.tongueVariant[n] = variant;
        }
        tongue.setVisible(power > 0.01).setPosition(this.nz.x + side * width * 0.28, this.nz.y).setAngle(angle + side * 17)
          .setScale((width * (m === 0 ? 1 : 0.62)) / FLAME_TONGUE_W, (length * lenK) / FLAME_TONGUE_H).setAlpha(Math.min(1, power * 1.3));
      }
      const visible = power > 0.01;
      core.setVisible(visible).setPosition(this.nz.x, this.nz.y - f.width * 0.01).setAngle(angle * 0.9)
        .setScale((width * 0.5) / 24, (length * 0.7) / 96).setAlpha(Math.min(1, power * 1.2));
      // A white-hot spot where each jet leaves the board.
      this.hot[k].setVisible(visible).setPosition(this.nz.x, this.nz.y + length * 0.06)
        .setScale((width * 1.15 * (calm ? 1 : 1 + 0.12 * Math.sin(t * 0.07 + j))) / 64).setAlpha(0.85 * Math.min(1, power * 1.3));
    }
  }

  private drawGlow(f: FlameFrame): void {
    const power = this.state.power;
    const pulse = this.reducedMotion ? 1 : 1 + 0.08 * Math.sin(this.clock * 0.05);
    const visible = power > 0.01;
    this.halo.setVisible(visible).setPosition(f.x, f.y - f.width * 0.2)
      .setScale((f.width * 2.7 * pulse) / 64).setAlpha(0.55 * power);
    // A faint additive wash over the rider: warms the suit and board without covering them.
    this.topGlow.setVisible(visible).setPosition(f.x, f.y - f.width * 0.3).setScale((f.width * 1.1) / 64).setAlpha(0.16 * power);
    this.riderTint = this.warmTint(power);
  }

  private onEdge(edge: FlameEdge, f: FlameFrame): void {
    if (this.reducedMotion) return;
    const x = f.x, y = f.y - f.width * 0.13;
    if (edge === 'ignite' || edge === 'reignite') {
      const big = edge === 'ignite';
      this.flashAge = 0;
      this.flash.setPosition(x, y).setScale((f.width * (big ? 2.4 : 1.4)) / 64).setVisible(true);
      this.ringAge[this.ringCursor] = 0;
      this.ringX[this.ringCursor] = x; this.ringY[this.ringCursor] = y;
      this.ringSize[this.ringCursor] = f.width * (big ? 2.6 : 1.6);
      this.ringImages[this.ringCursor].setVisible(true);
      this.ringCursor = (this.ringCursor + 1) % FLAME_POOLS.rings;
      const n = big ? 22 : 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + this.rand() * 0.3;
        const v = this.between(140, big ? 380 : 260);
        this.embers.spawn(x + Math.cos(a) * f.width * 0.12, y + Math.sin(a) * f.width * 0.05, Math.cos(a) * v, Math.sin(a) * v * 0.55 + 40, this.between(380, 760), 1.5, 0.3);
      }
      for (let i = 0; i < (big ? 8 : 3); i++) {
        this.blobs.spawn(x + this.between(-0.3, 0.3) * f.width, y, this.between(-90, 90), this.between(60, 200), this.between(260, 380), f.width * 0.3, f.width * 0.1);
      }
    } else {
      // Flame-out: a quick puff of smoke where the flames were, plus a few last embers.
      const n = edge === 'flameout' ? 8 : 4;
      for (let k = 0; k < n; k++) {
        const j = k & 1 ? 1 : -1;
        this.nozzle(j, f, this.nz);
        this.smoke.spawn(this.nz.x + this.between(-6, 6), this.nz.y + this.between(8, 30), this.between(-50, 50), this.between(40, 130), this.between(420, 700), f.width * 0.16, f.width * 0.5);
      }
      for (let k = 0; k < 4; k++) {
        this.embers.spawn(x + this.between(-0.3, 0.3) * f.width, y + 6, this.between(-80, 80), this.between(30, 140), this.between(260, 460), 1.1, 0.2);
      }
    }
  }
  private ringCursor = 0;

  private emit(dt: number, f: FlameFrame): void {
    const power = this.state.power;
    if (power < 0.2) return;
    const sp = 0.5 + 0.5 * f.speed01;
    for (let k = 0; k < 2; k++) {
      const j = k === 0 ? -1 : 1;
      this.nozzle(j, f, this.nz);
      // Flame-tail blobs, embers and smoke: rates are per second so density is the same at any frame rate.
      this.budget[k] += dt * 0.001 * (70 * sp) * power;
      while (this.budget[k] >= 1) {
        this.budget[k] -= 1;
        const along = this.between(0.1, 0.55) * f.width;
        this.blobs.spawn(
          this.nz.x + this.between(-0.05, 0.05) * f.width, this.nz.y + along,
          -f.lean * 60 + j * 70 + this.between(-30, 30), 120 + 200 * f.speed01 + this.between(0, 60),
          this.between(320, 520) * (0.75 + 0.4 * f.speed01), f.width * 0.34, f.width * 0.5
        );
        if (this.rand() < 0.5) {
          this.embers.spawn(this.nz.x + this.between(-8, 8), this.nz.y + along * 1.2, -f.lean * 90 + j * 90 + this.between(-70, 70), this.between(100, 300) + 160 * f.speed01, this.between(360, 760), 2.1, 0.35);
        }
        if (this.rand() < 0.3) {
          this.smoke.spawn(this.nz.x + this.between(-6, 6), this.nz.y + f.width * 0.6, -f.lean * 40 + this.between(-30, 30), 90 + 120 * f.speed01, this.between(520, 880), f.width * 0.1, f.width * 0.42);
        }
      }
    }
  }

  private stepBlobs(dt: number): void {
    const p = this.blobs;
    if (p.alive <= 0) return;
    for (let i = 0; i < p.count; i++) {
      if (p.age[i] >= p.life[i]) continue;
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) { p.kill(i); continue; }
      const t = p.age[i] / p.life[i], s = dt * 0.001;
      p.x[i] += p.vx[i] * s; p.y[i] += p.vy[i] * s;
      const size = p.s0[i] + (p.s1[i] - p.s0[i]) * t;
      p.images[i].setPosition(p.x[i], p.y[i]).setScale(size / 64).setTint(pick(BLOB_COLORS, t)).setAlpha(0.9 * Math.pow(1 - t, 0.7));
    }
  }

  private stepEmbers(dt: number): void {
    const p = this.embers;
    if (p.alive <= 0) return;
    for (let i = 0; i < p.count; i++) {
      if (p.age[i] >= p.life[i]) continue;
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) { p.kill(i); continue; }
      const t = p.age[i] / p.life[i], s = dt * 0.001;
      p.vy[i] += 260 * s; // embers fall away toward the camera and curve
      p.x[i] += p.vx[i] * s; p.y[i] += p.vy[i] * s;
      p.images[i].setPosition(p.x[i], p.y[i]).setScale(p.s0[i] + (p.s1[i] - p.s0[i]) * t).setTint(pick(EMBER_COLORS, t)).setAlpha(1 - t * t);
    }
  }

  private stepSmoke(dt: number): void {
    const p = this.smoke;
    if (p.alive <= 0) return;
    for (let i = 0; i < p.count; i++) {
      if (p.age[i] >= p.life[i]) continue;
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) { p.kill(i); continue; }
      const t = p.age[i] / p.life[i], s = dt * 0.001;
      p.x[i] += p.vx[i] * s; p.y[i] += p.vy[i] * s;
      const size = p.s0[i] + (p.s1[i] - p.s0[i]) * t;
      p.images[i].setPosition(p.x[i], p.y[i]).setScale(size / 16).setTint(pick(SMOKE_COLORS, t)).setAlpha(0.5 * Math.sin(Math.min(1, t * 3)) * (1 - t));
    }
  }

  private stepScorch(dt: number, f: FlameFrame): void {
    const p = this.scorch;
    if (this.state.power > 0.3 && !f.airborne) {
      this.scorchClock += dt;
      while (this.scorchClock >= 36) {
        this.scorchClock -= 36;
        for (let k = 0; k < 2; k++) {
          const j = k === 0 ? -1 : 1;
          const gx = f.x + (j * 0.27 - f.lean * 0.03) * f.width;
          p.spawn(gx, f.y + f.width * 0.02, -f.lean * 20, 120 + 330 * f.speed01, 520, f.width * 0.05, f.width * 0.3);
        }
      }
    }
    if (p.alive <= 0) return;
    for (let i = 0; i < p.count; i++) {
      if (p.age[i] >= p.life[i]) continue;
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) { p.kill(i); continue; }
      const t = p.age[i] / p.life[i], s = dt * 0.001;
      p.x[i] += p.vx[i] * s; p.y[i] += p.vy[i] * s;
      // It lies on the snow: it stretches as it slides toward the camera and cools from glowing orange to a wet dark streak.
      p.images[i].setPosition(p.x[i], p.y[i]).setScale(1.1 + t * 1.2, (p.s1[i] * (0.5 + t * 0.9)) / 24)
        .setTint(pick(SCORCH_COLORS, t)).setAlpha(0.85 * (1 - t) * Math.min(1, t * 8));
    }
  }

  private stepIgnition(dt: number): void {
    if (this.flashAge < this.flashLife) {
      this.flashAge += dt;
      const t = Math.min(1, this.flashAge / this.flashLife);
      if (t >= 1) this.flash.setVisible(false);
      else this.flash.setAlpha(0.9 * (1 - t) * (1 - t));
    }
    for (let i = 0; i < FLAME_POOLS.rings; i++) {
      if (this.ringAge[i] >= this.ringLife) continue;
      this.ringAge[i] += dt;
      const t = Math.min(1, this.ringAge[i] / this.ringLife);
      if (t >= 1) { this.ringImages[i].setVisible(false); continue; }
      const e = 1 - (1 - t) * (1 - t);
      this.ringImages[i].setPosition(this.ringX[i], this.ringY[i]).setScale((this.ringSize[i] * (0.3 + 0.7 * e)) / 96, (this.ringSize[i] * (0.3 + 0.7 * e) * 0.55) / 96).setAlpha(0.9 * (1 - t));
    }
  }

  private hideAll(): void {
    this.shown = false;
    this.halo.setVisible(false); this.topGlow.setVisible(false); this.flash.setVisible(false);
    this.tongues.forEach(i => i.setVisible(false));
    this.hot.forEach(i => i.setVisible(false));
    this.cores.forEach(i => i.setVisible(false));
    this.ringImages.forEach(i => i.setVisible(false));
    this.blobs.hideAll(); this.embers.hideAll(); this.smoke.hideAll(); this.scorch.hideAll();
    this.flashAge = this.flashLife; this.ringAge.fill(this.ringLife);
    this.scorchClock = 0; this.budget.fill(0);
  }

  /** Number of pooled images currently drawn; for tests and the frame-cost probe. */
  get visibleCount(): number {
    return this.blobs.alive + this.embers.alive + this.smoke.alive + this.scorch.alive;
  }
}
