import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { MOUNTAIN, SKY, mix, shade } from './palette';

export const SKY_DETAILS_KEY = 'sky-details-alpine';

/** Power-of-two, seamless strips remain cheap on WebGL's TileSprite path. */
const RIDGE_WIDTH = 2048;
export const MOUNTAIN_LAYERS = [
  { key: 'mountain-far', top: 112, height: 256, parallax: 0.012 },
  { key: 'mountain-mid', top: 142, height: 256, parallax: 0.026 },
  { key: 'mountain-near', top: 194, height: 256, parallax: 0.045 }
] as const;

const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** Code-generated alpine artwork, cached once across title/race/restarts.
 * Large irregular facets and directional snow give the peaks a recognisable
 * silhouette; no runtime random calls or per-frame geometry is required. */
export function generateMountainTextures(scene: Phaser.Scene): void {
  generateSkyDetails(scene);
  const bodies = [MOUNTAIN.far, MOUNTAIN.mid, MOUNTAIN.near];
  const caps = [MOUNTAIN.capFar, MOUNTAIN.capMid, MOUNTAIN.capNear];
  MOUNTAIN_LAYERS.forEach((layer, index) => {
    if (scene.textures.exists(layer.key)) return;
    const texture = scene.textures.createCanvas(layer.key, RIDGE_WIDTH, layer.height);
    if (!texture) return;
    const ctx = texture.getContext();
    const haze = 0.56 - index * 0.18;
    const body = mix(bodies[index], SKY.horizon, haze);
    const lit = mix(body, caps[index], 0.28);
    const shadow = mix(shade(body, 'shadow'), body, 0.72);
    const cap = mix(mix(caps[index], SKY.cloud, 0.18), SKY.horizon, haze * 0.6);
    const capShadow = mix(cap, body, 0.45);
    let seed = 0x91e3 + index * 0x235;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    // Valleys and summits share endpoints; repeating the first valley at the
    // far edge keeps both geometry and height continuous across the seam.
    const count = 8;
    // Broad irregular massifs leave quiet sky between memorable summits. Equal
    // 128px triangles read like wallpaper even with otherwise rich shading.
    const widths = Array.from({ length: count }, () => 150 + random() * 230);
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    const valleys = Array.from({ length: count }, () => 112 + random() * 52);
    let cursor = 0;
    const polygon = (color: number, points: number[]): void => {
      ctx.fillStyle = css(color);
      ctx.beginPath();
      ctx.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
      ctx.closePath();
      ctx.fill();
    };
    for (let i = 0; i < count; i++) {
      const step = widths[i] / totalWidth * RIDGE_WIDTH;
      const left = cursor;
      const right = left + step;
      cursor = right;
      const peakX = left + step * (0.24 + random() * 0.5);
      const peakY = i % 3 === 1 ? 8 + random() * 22 : 37 + random() * 49;
      const leftY = valleys[i];
      const rightY = valleys[(i + 1) % count];
      const fold = peakX + step * (0.16 + random() * 0.12);
      const shoulderX = peakX + (right - peakX) * 0.48;
      const shoulderY = peakY + (rightY - peakY) * (0.22 + random() * 0.16);
      polygon(body, [left, leftY, peakX, peakY, shoulderX, shoulderY,
        right, rightY, right, 256, left, 256]);
      // Upper-left is sunward, matching all the generated rider/obstacle art.
      polygon(lit, [left, leftY, peakX, peakY, peakX - step * 0.16, 205, left, 256]);
      polygon(shadow, [peakX, peakY, shoulderX, shoulderY, right, rightY, right, 256, fold, 230]);
      const snowY = peakY + Math.min(28 + random() * 29, (Math.min(leftY, rightY) - peakY) * 0.62);
      const leftSnowX = peakX + (left - peakX) * (snowY - peakY) / (leftY - peakY);
      const rightSnowX = peakX + (right - peakX) * (snowY - peakY) / (rightY - peakY);
      polygon(cap, [peakX, peakY, leftSnowX, snowY,
        peakX - 12, snowY - 8, peakX - 3, snowY + 13, peakX + 7, snowY - 5,
        rightSnowX, snowY]);
      polygon(capShadow, [peakX, peakY, peakX + 7, snowY - 5,
        peakX + 16, snowY + 7, rightSnowX, snowY]);
      // A long, sparse couloir helps the snow read as terrain, not frosting.
      if (i % 3 === 0) polygon(capShadow, [peakX + 7, snowY - 5,
        fold - 8, snowY + 60, fold - 1, snowY + 47]);
    }
    texture.refresh();
  });
}

function generateSkyDetails(scene: Phaser.Scene): void {
  if (scene.textures.exists(SKY_DETAILS_KEY)) return;
  const texture = scene.textures.createCanvas(SKY_DETAILS_KEY, SCREEN_W, SCREEN_H);
  if (!texture) return;
  const ctx = texture.getContext();
  // Restrained warm sun, in the same upper-left light direction as the art.
  const x = SCREEN_W * 0.23;
  const y = SCREEN_H * 0.19;
  const glow = ctx.createRadialGradient(x, y, 10, x, y, 94);
  glow.addColorStop(0, 'rgba(255,246,222,0.24)');
  glow.addColorStop(1, 'rgba(255,246,222,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x - 94, y - 94, 188, 188);
  ctx.fillStyle = css(SKY.sun);
  ctx.beginPath();
  ctx.arc(x, y, 17, 0, Math.PI * 2);
  ctx.fill();
  // Thin high cloud has a soft, wind-stretched silhouette. Its deliberately
  // quiet contrast leaves the HUD and mountain silhouettes uncluttered.
  ctx.fillStyle = css(SKY.cloud);
  ctx.globalAlpha = 0.16;
  const clouds = [[54, 155, 108], [372, 83, 122], [695, 119, 160], [828, 64, 98]];
  for (const [cx, cy, width] of clouds) {
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.25, cy + 4);
    ctx.bezierCurveTo(cx + width * 0.12, cy + 2, cx + width * 0.2, cy - 11,
      cx + width * 0.46, cy - 7);
    ctx.bezierCurveTo(cx + width * 0.72, cy - 12, cx + width * 0.76, cy + 2,
      cx + width * 1.35, cy + 4);
    ctx.bezierCurveTo(cx + width * 0.78, cy + 8, cx + width * 0.1, cy + 10,
      cx - width * 0.25, cy + 4);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  texture.refresh();
}
