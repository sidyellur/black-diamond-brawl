import { PICKUP, SNOW, shade } from '../render/palette';
import { PixelCanvas, applyRim } from '../render/pixel';

/**
 * The ski-pole pickup.
 *
 * A pickup has a different job from an obstacle: it must read as *collectable*
 * at a glance, not just be visible. That means a shape distinct from anything
 * else on the slope (crossed diagonals — nothing else in the game is diagonal)
 * and a warm accent colour against an otherwise entirely cool palette.
 *
 * Drawn to stand on the bottom edge of its frame, matching the obstacle
 * convention so origin (0.5, 1) plants it on the road.
 */

export const PICKUP_ART_SIZE = 48;

export function drawPickup(): PixelCanvas {
  const cv = new PixelCanvas(PICKUP_ART_SIZE, PICKUP_ART_SIZE);
  const cx = 24;
  const base = 45;

  // A soft glow pad underneath, so the pickup separates from the snow even
  // before the rim goes on. Reads as "this one is for you".
  cv.ellipse(cx, base - 2, 13, 4, PICKUP.glow, 90);

  drawPole(cv, cx, base, -7);
  drawPole(cv, cx, base, 7);

  applyRim(cv, SNOW.packed);
  return cv;
}

/** One pole, planted at an angle. `tilt` is the horizontal offset of the top
 *  from the base, so a mirrored pair crosses into an X. */
function drawPole(cv: PixelCanvas, cx: number, base: number, tilt: number): void {
  const topY = base - 34;
  const botX = cx - tilt * 0.4;
  const topX = cx + tilt;

  // Shaft, with a lit side — a single-tone bar reads as a stick, a two-tone
  // one reads as a metal tube.
  cv.line(botX, base - 2, topX, topY, shade(PICKUP.shaft, 'shadow'), 3);
  cv.line(botX - 1, base - 2, topX - 1, topY, PICKUP.shaft, 1);

  // Basket near the tip.
  const bx = Math.round(botX + (topX - botX) * 0.22);
  const by = Math.round(base - 2 + (topY - (base - 2)) * 0.22);
  cv.ellipse(bx, by, 4, 2, PICKUP.basket);
  cv.ellipse(bx, by - 1, 3, 1, shade(PICKUP.basket, 'hilite'));

  // Grip.
  cv.rect(topX - 2, topY, 4, 6, PICKUP.grip);
  cv.rect(topX - 2, topY, 1, 6, shade(PICKUP.grip, 'lit'));
}
