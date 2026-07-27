/**
 * A tiny pixel canvas for authoring sprites in code.
 *
 * Drawing sprites with Phaser's `Graphics` API is the wrong tool for this job:
 * it anti-aliases, it has no notion of a pixel grid, and reading back what you
 * drew is impossible — so the shading is guesswork and the edges are mush at
 * the small sizes the projection actually renders at.
 *
 * This works on a raw `Uint8ClampedArray` instead. Every operation lands on
 * exact pixels, and because the buffer is readable the two techniques that
 * matter most for a snow game become possible at all:
 *
 *   - `applyRim()` needs to know which pixels are on the silhouette edge,
 *     which requires reading neighbours.
 *   - `applyAlbedoBudget()` needs to measure what was drawn and remap it,
 *     which requires reading the whole sprite back.
 *
 * Both are described in the v2 epic §4.1; neither is expressible in a
 * write-only immediate-mode API.
 */
import { deltaL, luminance, MIN_OUTLINE_DELTA_L, rim, SNOW, toRgb } from './palette';

export class PixelCanvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  private idx(x: number, y: number): number {
    return (y * this.w + x) * 4;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  alphaAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.data[this.idx(x, y) + 3];
  }

  colorAt(x: number, y: number): number {
    const i = this.idx(x, y);
    return ((this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2]) >>> 0;
  }

  set(x: number, y: number, hex: number, alpha = 255): void {
    if (!this.inBounds(x, y)) return;
    const { r, g, b } = toRgb(hex);
    const i = this.idx(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = alpha;
  }

  rect(x: number, y: number, w: number, h: number, hex: number): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, hex);
    }
  }

  /** Filled ellipse, inclusive of its bounding box. */
  ellipse(cx: number, cy: number, rx: number, ry: number, hex: number, alpha = 255): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, hex, alpha);
      }
    }
  }

  /** Filled triangle via barycentric coverage. */
  triangle(
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    hex: number
  ): void {
    const minX = Math.floor(Math.min(x1, x2, x3));
    const maxX = Math.ceil(Math.max(x1, x2, x3));
    const minY = Math.floor(Math.min(y1, y2, y3));
    const maxY = Math.ceil(Math.max(y1, y2, y3));
    const area = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
    if (area === 0) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w1 = ((x2 - px) * (y3 - py) - (x3 - px) * (y2 - py)) / area;
        const w2 = ((x3 - px) * (y1 - py) - (x1 - px) * (y3 - py)) / area;
        const w3 = 1 - w1 - w2;
        if (w1 >= 0 && w2 >= 0 && w3 >= 0) this.set(x, y, hex);
      }
    }
  }

  /** Thick line, drawn as a run of small squares. */
  line(x1: number, y1: number, x2: number, y2: number, hex: number, thickness = 1): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2 + 1;
    const half = Math.floor(thickness / 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(x1 + (x2 - x1) * t);
      const y = Math.round(y1 + (y2 - y1) * t);
      for (let oy = -half; oy <= half; oy++) {
        for (let ox = -half; ox <= half; ox++) this.set(x + ox, y + oy, hex);
      }
    }
  }

  /** Copies another canvas at an offset, skipping fully transparent pixels. */
  blit(src: PixelCanvas, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        if (src.alphaAt(x, y) === 0) continue;
        const i = src.idx(x, y);
        this.set(x + dx, y + dy, src.colorAt(x, y), src.data[i + 3]);
      }
    }
  }
}

/**
 * Darkens the outer edge of a sprite so it separates from the surface behind
 * it.
 *
 * This is the 2D form of what a photograph gets for free: at an object's
 * silhouette you look along its surface, through the full depth of fabric nap
 * and self-shadowing, so almost nothing comes back. Snow is the brightest
 * possible backdrop, and without this every rider and obstacle dissolves into
 * it — the single highest-value technique in the whole overhaul.
 *
 * Only pixels bordering transparency are touched, so interior shading is left
 * alone. The tone is picked by `rim()`, which walks darker until it clears
 * `MIN_OUTLINE_DELTA_L` against the background.
 */
export function applyRim(cv: PixelCanvas, against: number = SNOW.packed): void {
  const edges: Array<[number, number, number]> = [];
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      if (cv.alphaAt(x, y) === 0) continue;
      const exposed =
        cv.alphaAt(x - 1, y) === 0 ||
        cv.alphaAt(x + 1, y) === 0 ||
        cv.alphaAt(x, y - 1) === 0 ||
        cv.alphaAt(x, y + 1) === 0;
      if (exposed) edges.push([x, y, rim(cv.colorAt(x, y), against)]);
    }
  }
  for (const [x, y, c] of edges) cv.set(x, y, c);
}

/**
 * Remaps a sprite's overall lightness into a target window while preserving
 * its internal contrast.
 *
 * Sprites authored at "natural" lightness disappear against snow — the same
 * failure as a soldier rendering brighter than the building behind him. The
 * fix is to measure what was actually drawn and remap it, rather than
 * guessing colours that might work.
 *
 * Preserving the internal ratio is the part that is easy to get wrong:
 * squashing everything into a narrow band does guarantee contrast against the
 * background, but it also flattens the sprite into a silhouette with no
 * readable form. So the mean is moved and the spread is scaled, not clipped.
 */
export function applyAlbedoBudget(
  cv: PixelCanvas,
  targetMean: number,
  contrastScale = 1.0
): void {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      if (cv.alphaAt(x, y) === 0) continue;
      sum += luminance(cv.colorAt(x, y));
      n++;
    }
  }
  if (n === 0) return;
  const mean = sum / n;
  if (mean <= 0) return;

  const shift = targetMean / mean;
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      if (cv.alphaAt(x, y) === 0) continue;
      const c = cv.colorAt(x, y);
      const l = luminance(c);
      // Move toward the target mean, then re-expand deviation from it so the
      // sprite keeps its own light/dark structure.
      const scaled = l * shift;
      const finalL = targetMean + (scaled - targetMean) * contrastScale;
      const factor = l > 0 ? finalL / l : 1;
      const { r, g, b } = toRgb(c);
      cv.set(
        x,
        y,
        ((Math.min(255, Math.round(r * factor)) << 16) |
          (Math.min(255, Math.round(g * factor)) << 8) |
          Math.min(255, Math.round(b * factor))) >>> 0,
        cv.alphaAt(x, y)
      );
    }
  }
}

/** Worst-case contrast of a sprite's outline against a background — the
 *  measurement the palette gate asserts on. */
export function measureOutlineContrast(cv: PixelCanvas, against: number = SNOW.packed): number {
  let worst = Infinity;
  let found = false;
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      if (cv.alphaAt(x, y) === 0) continue;
      const exposed =
        cv.alphaAt(x - 1, y) === 0 ||
        cv.alphaAt(x + 1, y) === 0 ||
        cv.alphaAt(x, y - 1) === 0 ||
        cv.alphaAt(x, y + 1) === 0;
      if (!exposed) continue;
      found = true;
      worst = Math.min(worst, deltaL(cv.colorAt(x, y), against));
    }
  }
  return found ? worst : 0;
}

export const OUTLINE_TARGET = MIN_OUTLINE_DELTA_L;

/** Registers a finished canvas as a Phaser texture. */
export function registerTexture(
  scene: Phaser.Scene,
  key: string,
  cv: PixelCanvas
): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, cv.w, cv.h);
  if (!tex) return;
  const ctx = tex.getContext();
  const img = ctx.createImageData(cv.w, cv.h);
  img.data.set(cv.data);
  ctx.putImageData(img, 0, 0);
  tex.refresh();
}
