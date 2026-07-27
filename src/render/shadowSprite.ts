import Phaser from 'phaser';
import { SNOW } from './palette';
import { PixelCanvas, registerTexture } from './pixel';

export const SHADOW_TEXTURE_KEY = 'contact-shadow';
export const SHADOW_SIZE = 48;

/**
 * A soft elliptical contact shadow.
 *
 * Nothing in the game was grounded before this: sprites sat at the road's
 * projected Y with no indication they were touching it, and an airborne rider
 * simply slid upward with nothing to say how high it was. A contact shadow is
 * the cheapest possible fix for both — it fixes the object to the surface, and
 * the gap between sprite and shadow *is* the height read.
 *
 * Authored as pure black with varying alpha rather than as a grey. Under
 * standard source-alpha blending, black at alpha k is exactly a multiply by
 * (1 - k), so the shadow darkens whatever it lands on — snow, a road band, a
 * rumble strip — instead of stamping one fixed grey over all of them. A shadow
 * that is ever *brighter* than its surroundings reads as a sticker.
 *
 * Drawn as a sprite, not Graphics, so it obeys the same pixel-positioning
 * rules as the object casting it and cannot drift against it by a pixel.
 */
export function generateShadowTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(SHADOW_TEXTURE_KEY)) {
    return;
  }

  const size = SHADOW_SIZE;
  const cv = new PixelCanvas(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rx = size / 2 - 1;
  const ry = size / 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      // Quadratic falloff with a soft shoulder. A hard-edged ellipse reads as
      // a painted spot; real contact shadows are dense under the object and
      // dissolve outward as the occluder's silhouette softens.
      const a = Math.pow(1 - d, 1.6);
      cv.set(x, y, 0x000000, Math.round(a * 150));
    }
  }

  registerTexture(scene, SHADOW_TEXTURE_KEY, cv);
}

/** The tone a shadow lands on over open piste — used by the palette gate to
 *  confirm the shadow is a darkening, never a lightening. */
export const SHADOW_OVER_SNOW_REFERENCE = SNOW.packed;
