import Phaser from 'phaser';
import { SNOW, mix } from './palette';
import { PixelCanvas, registerTexture } from './pixel';

export const SNOW_PUFF_KEY = 'fx-snow-puff';
export const SPARK_KEY = 'fx-spark';
export const FLAKE_KEY = 'fx-flake';

/**
 * Particle textures, painted per-pixel.
 *
 * The shape rule that matters: erosion is applied only near the rim, so the
 * silhouette tears while the core stays dense. A puff eroded uniformly reads
 * as static; one with a solid centre and a ragged edge reads as thrown snow.
 *
 * The snow puff in particular uses a soft radial ramp rather than a hard
 * alpha threshold — thresholding scatters hard white dots through the sprite,
 * which reads as grain or dirt instead of powder.
 */
export function generateParticleTextures(scene: Phaser.Scene): void {
  generateSnowPuff(scene);
  generateSpark(scene);
  generateFlake(scene);
}

function generateSnowPuff(scene: Phaser.Scene): void {
  if (scene.textures.exists(SNOW_PUFF_KEY)) return;
  const size = 16;
  const cv = new PixelCanvas(size, size);
  const c = size / 2;

  // Deterministic hash so the puff is identical every run.
  let seed = 0x51ed;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / c;
      if (d > 1) continue;
      // Soft ramp, not a threshold.
      let a = Math.pow(1 - d, 1.5);
      // Erode only the outer band, so the core survives intact.
      const rimT = Math.max(0, (d - 0.45) / 0.55);
      a *= 1 - rimT * rnd() * 0.85;
      if (a <= 0.02) continue;
      cv.set(x, y, mix(SNOW.packed, 0xffffff, 0.5), Math.round(a * 255));
    }
  }
  registerTexture(scene, SNOW_PUFF_KEY, cv);
}

/** A small bright chip for combat hits — sharp, unlike the soft snow puff, so
 *  an impact does not read as more spray. */
function generateSpark(scene: Phaser.Scene): void {
  if (scene.textures.exists(SPARK_KEY)) return;
  const size = 8;
  const cv = new PixelCanvas(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x + 0.5 - c);
      const dy = Math.abs(y + 0.5 - c);
      // Diamond, not a disc — reads as a glint rather than a ball.
      const d = (dx + dy) / c;
      if (d > 1) continue;
      cv.set(x, y, 0xfff2c8, Math.round(Math.pow(1 - d, 0.8) * 255));
    }
  }
  registerTexture(scene, SPARK_KEY, cv);
}

/** Ambient falling snow — a single soft dot. */
function generateFlake(scene: Phaser.Scene): void {
  if (scene.textures.exists(FLAKE_KEY)) return;
  const size = 4;
  const cv = new PixelCanvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      if (d > 1) continue;
      cv.set(x, y, 0xffffff, Math.round((1 - d) * 210));
    }
  }
  registerTexture(scene, FLAKE_KEY, cv);
}
