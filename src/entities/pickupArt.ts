import { PICKUP, SNOW, UI, rim, shade } from '../render/palette';
import { PixelCanvas } from '../render/pixel';
import { Point, VectorPainter, preserveAlphaRim, linearGradient, smoothContour } from '../render/vectorArt';

export const PICKUP_ART_SIZE = 192;

/** Two gleaming ski poles with molded grips and wrist loops. The crossed
 * silhouette and gold hardware make the reward distinct from cold hazards. */
export function drawPickup(): PixelCanvas {
  const canvas = new PixelCanvas(PICKUP_ART_SIZE, PICKUP_ART_SIZE);
  const p = new VectorPainter(canvas);
  const pad = linearGradient(77, 172, 121, 190, [PICKUP.glow, PICKUP.basket, shade(PICKUP.basket, 'shadow')]);
  p.ellipse(96, 184, 35, 7, rim(PICKUP.basket));
  p.ellipse(96, 183, 28.5, 3.5, pad);
  drawPole(p, [57, 31], [123, 183], -1);
  drawPole(p, [136, 31], [70, 183], 1);
  // Restrained four-point material glints stay attached to the metal.
  glint(p, 82, 90, 5);
  glint(p, 120, 66, 4);
  preserveAlphaRim(canvas, SNOW.packed);
  return canvas;
}

function drawPole(p: VectorPainter, top: Point, tip: Point, side: number): void {
  const edge = rim(PICKUP.shaft);
  const gripEnd: Point = [top[0] + (tip[0] - top[0]) * 0.16, top[1] + 25];
  const basket: Point = [top[0] + (tip[0] - top[0]) * 0.84, top[1] + (tip[1] - top[1]) * 0.84];
  p.line(top, tip, 10, edge);
  p.line([top[0] - 0.8, top[1]], [tip[0] - 0.8, tip[1]], 4.6,
    linearGradient(72, 50, 129, 177, [SNOW.packed, PICKUP.shaft, shade(PICKUP.shaft, 'shadow')]));
  p.line([top[0] + (tip[0] - top[0]) * 0.18 - 1.4, top[1] + (tip[1] - top[1]) * 0.18],
    [top[0] + (tip[0] - top[0]) * 0.94 - 1.4, top[1] + (tip[1] - top[1]) * 0.94],
    1.2, SNOW.packed, 0.9);
  p.line(top, gripEnd, 14, edge);
  p.line([top[0] - 1.3, top[1]], [gripEnd[0] - 1.3, gripEnd[1]], 10,
    linearGradient(top[0] - 6, top[1], top[0] + 9, top[1] + 5, [shade(PICKUP.grip, 'lit'), PICKUP.grip, shade(PICKUP.grip, 'shadow')]));
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    const x = top[0] + (gripEnd[0] - top[0]) * t;
    const y = top[1] + (gripEnd[1] - top[1]) * t;
    p.line([x - 4, y + side], [x + 4, y - side], 1.1, shade(PICKUP.grip, 'hilite'), 0.8);
  }
  p.line([gripEnd[0] - 3, gripEnd[1]], [gripEnd[0] + 4, gripEnd[1] - 2], 3.7, PICKUP.basket);
  const strap = smoothContour([
    [top[0] + side * 3, top[1] - 2], [top[0] + side * 16, top[1] - 8],
    [top[0] + side * 21, top[1] + 2], [top[0] + side * 15, top[1] + 17],
    [top[0] + side * 5, top[1] + 12]
  ]);
  p.stroke(strap, 3.2, edge, true);
  p.stroke(strap, 1.2, shade(PICKUP.grip, 'hilite'), true);
  p.ellipse(basket[0], basket[1], 15.5, 7.5, edge, side * 0.22);
  p.ellipse(basket[0] - 0.7, basket[1] - 0.7, 10.5, 3.7,
    linearGradient(basket[0], basket[1] - 4, basket[0], basket[1] + 4,
      [PICKUP.glow, PICKUP.basket, shade(PICKUP.basket, 'shadow')]), side * 0.22);
  p.line([tip[0], tip[1] - 8], tip, 3.5, PICKUP.grip);
}

function glint(p: VectorPainter, x: number, y: number, size: number): void {
  const points: Point[] = [[x, y - size], [x + 1.5, y - 1.5], [x + size * 0.65, y],
    [x + 1.5, y + 1.5], [x, y + size], [x - 1.5, y + 1.5],
    [x - size * 0.65, y], [x - 1.5, y - 1.5]];
  p.polygon(points, UI.inkHigh);
  p.stroke(points, 2.8, rim(PICKUP.shaft), true);
}
