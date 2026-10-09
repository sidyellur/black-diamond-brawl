import { PixelCanvas } from './pixel';
import { rim, SNOW } from './palette';

export type Point = [number, number];
export type Paint = number | ((x: number, y: number) => number);

/** A lookup ramp keeps high-resolution material shading cheap at boot. */
export function linearGradient(x1: number, y1: number, x2: number, y2: number, colors: number[]): Paint {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy || 1;
  const ramp = Array.from({ length: 256 }, (_, index) => {
    const t = index / 255 * (colors.length - 1);
    const a = colors[Math.floor(t)];
    const b = colors[Math.min(colors.length - 1, Math.floor(t) + 1)];
    const f = t % 1;
    const channel = (shift: number): number => Math.round(((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f);
    return (channel(16) << 16) | (channel(8) << 8) | channel(0);
  });
  return (x, y) => ramp[Math.min(255, Math.max(0, Math.round(((x - x1) * dx + (y - y1) * dy) / length * 255)))];
}

export function transformed(points: Point[], x: number, y: number, angle = 0): Point[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([px, py]) => [x + px * cos - py * sin, y + px * sin + py * cos]);
}

/** Closed Catmull–Rom contours: authored smooth shapes, not enlarged pixel art. */
export function smoothContour(points: Point[], steps = 8): Point[] {
  const curve: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i + points.length - 1) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      const axis = (k: number): number => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t);
      curve.push([axis(0), axis(1)]);
    }
  }
  return curve;
}

/** DOM-free, antialiased vector rasterizer shared by the game and art tests. */
export class VectorPainter {
  constructor(readonly canvas: PixelCanvas) {}

  private blend(x: number, y: number, paint: Paint, opacity: number): void {
    if (opacity <= 0 || !this.canvas.inBounds(x, y)) return;
    const color = typeof paint === 'number' ? paint : paint(x, y);
    const data = this.canvas.data;
    const i = (y * this.canvas.w + x) * 4;
    const oldAlpha = data[i + 3] / 255;
    const alpha = opacity + oldAlpha * (1 - opacity);
    const ratio = opacity / alpha;
    data[i] = ((color >> 16) & 255) * ratio + data[i] * (1 - ratio);
    data[i + 1] = ((color >> 8) & 255) * ratio + data[i + 1] * (1 - ratio);
    data[i + 2] = (color & 255) * ratio + data[i + 2] * (1 - ratio);
    data[i + 3] = alpha * 255;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, paint: Paint, angle = 0, opacity = 1): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const extentX = Math.abs(rx * cos) + Math.abs(ry * sin) + 1;
    const extentY = Math.abs(rx * sin) + Math.abs(ry * cos) + 1;
    for (let y = Math.max(0, Math.floor(cy - extentY)); y <= Math.min(this.canvas.h - 1, Math.ceil(cy + extentY)); y++) {
      for (let x = Math.max(0, Math.floor(cx - extentX)); x <= Math.min(this.canvas.w - 1, Math.ceil(cx + extentX)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const qx = (dx * cos + dy * sin) / rx;
        const qy = (-dx * sin + dy * cos) / ry;
        const coverage = Math.max(0, Math.min(1, (1 - Math.sqrt(qx * qx + qy * qy)) * Math.min(rx, ry) + 0.5));
        this.blend(x, y, paint, coverage * opacity);
      }
    }
  }

  line(a: Point, b: Point, width: number, paint: Paint, opacity = 1): void {
    const radius = width / 2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = dx * dx + dy * dy || 1;
    for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1]) - radius - 1)); y <= Math.min(this.canvas.h - 1, Math.ceil(Math.max(a[1], b[1]) + radius + 1)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0]) - radius - 1)); x <= Math.min(this.canvas.w - 1, Math.ceil(Math.max(a[0], b[0]) + radius + 1)); x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - a[0]) * dx + (y + 0.5 - a[1]) * dy) / length));
        const distance = Math.hypot(x + 0.5 - a[0] - t * dx, y + 0.5 - a[1] - t * dy);
        this.blend(x, y, paint, Math.max(0, Math.min(1, radius + 0.5 - distance)) * opacity);
      }
    }
  }

  stroke(points: Point[], width: number, paint: Paint, closed = false, opacity = 1): void {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1], points[i], width, paint, opacity);
    if (closed) this.line(points[points.length - 1], points[0], width, paint, opacity);
  }

  polygon(points: Point[], paint: Paint, opacity = 1): void {
    const minX = Math.max(0, Math.floor(Math.min(...points.map(([x]) => x))));
    const maxX = Math.min(this.canvas.w - 1, Math.ceil(Math.max(...points.map(([x]) => x))));
    const minY = Math.max(0, Math.floor(Math.min(...points.map(([, y]) => y))));
    const maxY = Math.min(this.canvas.h - 1, Math.ceil(Math.max(...points.map(([, y]) => y))));
    const inside = (x: number, y: number): boolean => {
      let hit = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i];
        const b = points[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
      }
      return hit;
    };
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let coverage = 0;
        for (const ox of [0.25, 0.75]) for (const oy of [0.25, 0.75]) if (inside(x + ox, y + oy)) coverage += 0.25;
        this.blend(x, y, paint, coverage * opacity);
      }
    }
  }

  shape(points: Point[], paint: Paint, outline = 0x14232d, width = 2): void {
    const contour = smoothContour(points);
    this.polygon(contour, paint);
    if (width > 0) this.stroke(contour, width, outline, true);
  }
}

/** Preserve fractional coverage while enforcing the outline contrast contract. */
export function preserveAlphaRim(cv: PixelCanvas, against: number = SNOW.packed): void {
  const edge: Array<[number, number, number, number]> = [];
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
    const alpha = cv.alphaAt(x, y);
    if (alpha && (!cv.alphaAt(x - 1, y) || !cv.alphaAt(x + 1, y) || !cv.alphaAt(x, y - 1) || !cv.alphaAt(x, y + 1))) {
      edge.push([x, y, rim(cv.colorAt(x, y), against), alpha]);
    }
  }
  for (const [x, y, color, alpha] of edge) cv.set(x, y, color, alpha);
}
