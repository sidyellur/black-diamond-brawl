import type Phaser from 'phaser';
import { PixelCanvas, registerTexture } from './pixel';

/** Textures for the boost rocket flames. All painted per pixel in code, once at boot. */
export const FLAME_KEYS = {
  tongueA: 'fx-flame-a',
  tongueB: 'fx-flame-b',
  core: 'fx-flame-core',
  glow: 'fx-flame-glow',
  ring: 'fx-flame-ring',
  streak: 'fx-flame-streak'
} as const;

export const FLAME_TONGUE_W = 44;
export const FLAME_TONGUE_H = 128;

const smooth = (t: number): number => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Flame colour ramp, from the hot axis (0) out to the cool rim (1): white-yellow, yellow, orange, red. */
const RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 255, 252, 232],
  [0.22, 255, 226, 110],
  [0.5, 255, 140, 24],
  [0.8, 238, 62, 10],
  [1.0, 170, 22, 8]
];
function ramp(t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (k <= RAMP[i][0]) {
      const a = RAMP[i - 1], b = RAMP[i];
      const f = (k - a[0]) / (b[0] - a[0]);
      return [lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f)];
    }
  }
  const last = RAMP[RAMP.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * One flame tongue, base at the top and tip at the bottom (it is drawn pointing down the screen,
 * away from the rider's board toward the camera). The colour is baked in: a white-yellow core along
 * the axis, orange body and red edge and tip, so one image is a whole flame. `phase` makes a second
 * variant with a different lick, and the game alternates them to flicker.
 */
export function drawFlameTongue(phase: number): PixelCanvas {
  const w = FLAME_TONGUE_W, h = FLAME_TONGUE_H;
  const cv = new PixelCanvas(w, h);
  for (let y = 0; y < h; y++) {
    const t = (y + 0.5) / h; // 0 at the nozzle, 1 at the tip
    const swing = Math.sin(t * 6 + phase) * 0.09 * w * t;
    const half = (w / 2 - 1) * Math.pow(Math.max(0, 1 - Math.pow(t, 1.35)), 0.8) * (1 + 0.16 * Math.sin(t * 12 + phase * 1.7));
    if (half <= 0.4) continue;
    const base = smooth(y / 7); // a rounded nozzle end rather than a hard cut
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2 - swing) / half;
      const d = Math.abs(dx);
      if (d >= 1) continue;
      // Heat falls with distance from the axis and along the length; the tip is the coolest part.
      const heat = Math.min(1, d * 0.95 + t * 0.55);
      const [r, g, b] = ramp(heat);
      const edge = smooth((1 - d) * 3.2);
      const alpha = edge * base * (1 - smooth((t - 0.8) / 0.2) * 0.5);
      if (alpha < 0.01) continue;
      const i = (y * w + x) * 4;
      cv.data[i] = r; cv.data[i + 1] = g; cv.data[i + 2] = b; cv.data[i + 3] = Math.round(alpha * 255);
    }
  }
  return cv;
}

/** The inner jet: a short, narrow white-yellow tongue laid over the main one. */
export function drawFlameCore(): PixelCanvas {
  const w = 24, h = 96;
  const cv = new PixelCanvas(w, h);
  for (let y = 0; y < h; y++) {
    const t = (y + 0.5) / h;
    const half = (w / 2 - 1) * Math.pow(Math.max(0, 1 - Math.pow(t, 1.15)), 0.9);
    if (half <= 0.4) continue;
    for (let x = 0; x < w; x++) {
      const d = Math.abs(x + 0.5 - w / 2) / half;
      if (d >= 1) continue;
      const alpha = smooth((1 - d) * 2.6) * smooth(y / 5) * (1 - t * 0.35);
      const mixToYellow = Math.min(1, t * 1.2 + d * 0.5);
      const i = (y * w + x) * 4;
      cv.data[i] = 255;
      cv.data[i + 1] = Math.round(lerp(252, 232, mixToYellow));
      cv.data[i + 2] = Math.round(lerp(236, 140, mixToYellow));
      cv.data[i + 3] = Math.round(alpha * 255);
    }
  }
  return cv;
}

/** A soft round light: the halo, the ignition flash and the flame-tail blobs (tinted per use). */
export function drawFlameGlow(size = 64): PixelCanvas {
  const cv = new PixelCanvas(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / c;
      if (d >= 1) continue;
      const a = Math.pow(1 - d, 1.7);
      const i = (y * size + x) * 4;
      cv.data[i] = 255; cv.data[i + 1] = 255; cv.data[i + 2] = 255; cv.data[i + 3] = Math.round(a * 255);
    }
  }
  return cv;
}

/** A thin soft ring for the ignition shock. */
export function drawFlameRing(size = 96): PixelCanvas {
  const cv = new PixelCanvas(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / c;
      const a = smooth(1 - Math.abs(d - 0.82) / 0.16);
      if (a <= 0.01) continue;
      const i = (y * size + x) * 4;
      cv.data[i] = 255; cv.data[i + 1] = 255; cv.data[i + 2] = 255; cv.data[i + 3] = Math.round(a * 255);
    }
  }
  return cv;
}

/** A scorch streak lying on the snow: long and narrow, soft at both ends. */
export function drawFlameStreak(): PixelCanvas {
  const w = 10, h = 48;
  const cv = new PixelCanvas(w, h);
  for (let y = 0; y < h; y++) {
    const along = smooth(Math.sin(((y + 0.5) / h) * Math.PI) * 1.4);
    for (let x = 0; x < w; x++) {
      const across = smooth(1 - Math.abs(x + 0.5 - w / 2) / (w / 2));
      const a = along * across;
      if (a <= 0.01) continue;
      const i = (y * w + x) * 4;
      cv.data[i] = 255; cv.data[i + 1] = 255; cv.data[i + 2] = 255; cv.data[i + 3] = Math.round(a * 255);
    }
  }
  return cv;
}

export function generateFlameTextures(scene: Phaser.Scene): void {
  registerTexture(scene, FLAME_KEYS.tongueA, drawFlameTongue(0));
  registerTexture(scene, FLAME_KEYS.tongueB, drawFlameTongue(2.4));
  registerTexture(scene, FLAME_KEYS.core, drawFlameCore());
  registerTexture(scene, FLAME_KEYS.glow, drawFlameGlow());
  registerTexture(scene, FLAME_KEYS.ring, drawFlameRing());
  registerTexture(scene, FLAME_KEYS.streak, drawFlameStreak());
}
