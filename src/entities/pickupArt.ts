import { PICKUP, PICKUP_KINDS_PALETTE as KP, SNOW, UI, rim, shade } from '../render/palette';
import { PixelCanvas } from '../render/pixel';
import type { PickupKind } from './pickup';
import { Point, VectorPainter, preserveAlphaRim, linearGradient, smoothContour } from '../render/vectorArt';

export const PICKUP_ART_SIZE = 192;

/** Letter glyph printed on each pickup, so the four read without colour. */
export const PICKUP_GLYPH: Record<PickupKind, string> = { pole: 'P', shield: 'S', wax: 'W', snowball: 'B' };

const GLYPH_STROKES: Record<string, Point[][]> = {
  P: [[[0, 1], [0, 0], [0.7, 0], [0.92, 0.18], [0.92, 0.36], [0.7, 0.55], [0, 0.55]]],
  S: [[[0.92, 0.14], [0.68, 0], [0.28, 0], [0.06, 0.16], [0.06, 0.36], [0.3, 0.5], [0.7, 0.58],
    [0.94, 0.72], [0.94, 0.86], [0.72, 1], [0.3, 1], [0.06, 0.86]]],
  W: [[[0, 0], [0.25, 1], [0.5, 0.36], [0.75, 1], [1, 0]]],
  B: [[[0, 0], [0, 1], [0.7, 1], [0.92, 0.85], [0.92, 0.65], [0.7, 0.5], [0, 0.5]],
    [[0, 0], [0.66, 0], [0.88, 0.14], [0.88, 0.36], [0.66, 0.5]]]
};

/** Dark disc with a white letter and a trim ring: the pickup's colour-free tag. */
function badge(p: VectorPainter, cx: number, cy: number, r: number, glyph: string, ring: number): void {
  p.ellipse(cx, cy, r + 3.5, r + 3.5, rim(ring));
  p.ellipse(cx, cy, r + 1, r + 1, ring);
  p.ellipse(cx, cy, r - 2, r - 2, KP.badge);
  const h = r * 1.0, w = r * 0.78;
  for (const stroke of GLYPH_STROKES[glyph]) {
    p.stroke(stroke.map(([x, y]): Point => [cx - w / 2 + x * w, cy - h / 2 + y * h]), r * 0.2, UI.inkHigh);
  }
}

function groundPad(p: VectorPainter, color: number): void {
  const pad = linearGradient(77, 172, 121, 190, [shade(color, 'lit'), color, shade(color, 'shadow')]);
  p.ellipse(96, 184, 35, 7, rim(color));
  p.ellipse(96, 183, 28.5, 3.5, pad);
}

/** Heater shield: a tall, pointed-bottom silhouette. */
function drawShield(): PixelCanvas {
  const canvas = new PixelCanvas(PICKUP_ART_SIZE, PICKUP_ART_SIZE);
  const p = new VectorPainter(canvas);
  groundPad(p, KP.shield.face);
  const outer: Point[] = [[96, 20], [140, 30], [150, 58], [144, 108], [124, 148], [96, 178],
    [68, 148], [48, 108], [42, 58], [52, 30]];
  p.shape(outer, rim(KP.shield.face), rim(KP.shield.face), 4);
  const body = linearGradient(46, 24, 148, 170, [KP.shield.lit, KP.shield.face, shade(KP.shield.deep, 'lit')]);
  const trimOuter = smoothContour(outer);
  p.polygon(trimOuter, linearGradient(46, 24, 148, 170, [UI.inkHigh, KP.shield.trim, shade(KP.shield.trim, 'shadow')]));
  const inner: Point[] = [[96, 32], [132, 40], [140, 60], [135, 104], [118, 140], [96, 164],
    [74, 140], [57, 104], [52, 60], [60, 40]];
  p.polygon(smoothContour(inner), body);
  p.line([96, 34], [96, 160], 3, shade(KP.shield.deep, 'core'), 0.55);
  p.line([60, 66], [132, 66], 3, shade(KP.shield.deep, 'core'), 0.45);
  p.stroke([[66, 50], [74, 40], [92, 36]], 4, KP.shield.lit, false, 0.9);
  badge(p, 96, 98, 25, 'S', KP.shield.trim);
  preserveAlphaRim(canvas, SNOW.packed);
  return canvas;
}

/** Speed wax: an upright wax bar with a lightning bolt, tilted like a dropped tin. */
function drawWax(): PixelCanvas {
  const canvas = new PixelCanvas(PICKUP_ART_SIZE, PICKUP_ART_SIZE);
  const p = new VectorPainter(canvas);
  groundPad(p, KP.wax.body);
  const edge = rim(KP.wax.body);
  const slab: Point[] = [[52, 40], [136, 40], [142, 168], [48, 168]];
  const sheen = linearGradient(48, 40, 142, 168, [KP.wax.lit, KP.wax.body, shade(KP.wax.deep, 'lit')]);
  p.polygon(slab, edge);
  p.polygon([[56, 44], [132, 44], [138, 164], [52, 164]], sheen);
  // Rounded cap and base rim: reads as a block of wax, not a flat card.
  p.ellipse(94, 40, 42, 11, edge);
  p.ellipse(94, 39, 38, 8, linearGradient(56, 31, 132, 47, [KP.wax.lit, KP.wax.body]));
  p.ellipse(95, 168, 46, 11, edge);
  p.ellipse(95, 166, 42, 8, shade(KP.wax.deep, 'lit'));
  p.line([62, 56], [66, 154], 5, KP.wax.lit, 0.7);
  // Lightning bolt across the label band.
  const bolt: Point[] = [[104, 70], [78, 108], [94, 108], [84, 142], [116, 98], [99, 98], [110, 70]];
  p.polygon(bolt, rim(KP.wax.bolt));
  p.polygon(bolt, KP.wax.bolt);
  badge(p, 96, 126, 19, 'W', KP.wax.bolt);
  preserveAlphaRim(canvas, SNOW.packed);
  return canvas;
}

/** Snowball: a packed sphere with a blue contour so it holds against white snow. */
function drawSnowball(): PixelCanvas {
  const canvas = new PixelCanvas(PICKUP_ART_SIZE, PICKUP_ART_SIZE);
  const p = new VectorPainter(canvas);
  groundPad(p, KP.snowball.shade);
  p.ellipse(96, 118, 56, 56, KP.snowball.deep);
  p.ellipse(96, 118, 52, 52, linearGradient(60, 72, 138, 168, [KP.snowball.lit, KP.snowball.mid, KP.snowball.shade]));
  p.ellipse(78, 92, 20, 12, KP.snowball.lit, -0.6, 0.85);
  // Packed-snow texture: scalloped shadow arcs.
  p.stroke([[58, 130], [70, 150], [92, 160]], 3, KP.snowball.shade, false, 0.8);
  p.stroke([[112, 78], [128, 90], [134, 106]], 3, KP.snowball.shade, false, 0.7);
  p.stroke([[100, 146], [120, 142], [132, 128]], 2.5, KP.snowball.shade, false, 0.7);
  badge(p, 98, 118, 22, 'B', KP.snowball.mid);
  preserveAlphaRim(canvas, SNOW.packed);
  return canvas;
}

export function drawPickupKind(kind: PickupKind): PixelCanvas {
  return kind === 'shield' ? drawShield() : kind === 'wax' ? drawWax()
    : kind === 'snowball' ? drawSnowball() : drawPickup();
}

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
  badge(p, 96, 112, 21, 'P', PICKUP.basket);
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
