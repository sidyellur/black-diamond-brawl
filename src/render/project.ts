import { CAMERA_DEPTH, ROAD_WIDTH, SCREEN_H, SCREEN_W } from '../config';

export interface ProjectedPoint {
  screenX: number;
  screenY: number;
  scale: number;
  /** Projected road half-width in screen space at this point's depth. */
  screenW: number;
}

/**
 * Projects a world-space point into screen space (design-spec §3.2).
 *
 * Returns `null` when the point is at or behind the camera (`dz <= 0`) —
 * callers must skip drawing in that case rather than divide by a zero or
 * negative `dz` (§3.4's behind-camera clamp).
 */
export function project(
  worldX: number,
  worldY: number,
  worldZ: number,
  camX: number,
  camY: number,
  camZ: number
): ProjectedPoint | null {
  const dz = worldZ - camZ;
  if (dz <= 0) {
    return null;
  }

  const scale = CAMERA_DEPTH / dz;
  const screenX = SCREEN_W / 2 + scale * (worldX - camX) * (SCREEN_W / 2);
  const screenY = SCREEN_H / 2 - scale * (worldY - camY) * (SCREEN_H / 2);
  const screenW = scale * ROAD_WIDTH * (SCREEN_W / 2);

  return { screenX, screenY, scale, screenW };
}
