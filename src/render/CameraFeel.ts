import type Phaser from 'phaser';
import { FEEL, SCREEN_H, SCREEN_W } from '../config';
import { setCameraDepthScale } from './project';

const smooth = (t: number): number => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/**
 * Camera moves for the feel pass, all on the world camera only (the HUD camera
 * never zooms or shakes).
 *
 *  - push: a short zoom-in with the view leaning toward the struck rival.
 *    Zooming in never exposes the edge of the drawing, and the lean is clamped
 *    to what the zoom itself covers.
 *  - settle: the view dips and returns after a trick landing; no shake.
 *  - boost pull-back: not a camera zoom at all. The road is drawn to the screen
 *    edges by a projection, so a zoom below 1 would show bare background. The
 *    projection's camera depth is eased down instead (a wider field of view),
 *    which fills the screen by construction and makes the rider shrink away.
 *
 * Idle cost is one comparison: `update` returns at once when nothing is moving.
 */
export class CameraFeel {
  private push = 0;
  private pushLife = 0;
  private pushDuration: number = FEEL.PUSH_MS;
  private pushStrength = 0;
  private aimX = 0;
  private aimY = 0;
  private settleLife = 0;
  private boost = 0;
  private boostTarget = 0;
  private depthSent = 1;
  private dirty = false;

  constructor(private readonly cam: Phaser.Cameras.Scene2D.Camera, private readonly reduced: boolean) {}

  /** `x`, `y` are screen coordinates of the thing to lean toward. */
  pushToward(x: number, y: number, strength: number, durationMs: number = FEEL.PUSH_MS): void {
    if (this.reduced) return;
    this.pushStrength = strength;
    this.pushLife = durationMs;
    this.pushDuration = durationMs;
    this.aimX = x - SCREEN_W / 2;
    this.aimY = y - SCREEN_H / 2;
    this.dirty = true;
  }

  settle(): void {
    if (this.reduced) return;
    this.settleLife = FEEL.SETTLE_MS;
    this.dirty = true;
  }

  setBoost(active: boolean): void {
    if (this.reduced) return;
    this.boostTarget = active ? 1 : 0;
  }

  get boostBlend(): number { return this.boost; }
  get depthScale(): number { return this.depthSent; }

  update(deltaMs: number): void {
    if (this.reduced) return;
    const boostMoving = this.boost !== this.boostTarget;
    if (!this.dirty && !boostMoving) return;

    if (boostMoving) {
      const step = deltaMs / FEEL.BOOST_EASE_MS;
      this.boost = this.boost < this.boostTarget ? Math.min(this.boostTarget, this.boost + step) : Math.max(this.boostTarget, this.boost - step);
      const scale = 1 - (1 - FEEL.BOOST_DEPTH_SCALE) * smooth(this.boost);
      if (scale !== this.depthSent) { this.depthSent = scale; setCameraDepthScale(scale); }
    }

    this.pushLife = Math.max(0, this.pushLife - deltaMs);
    this.settleLife = Math.max(0, this.settleLife - deltaMs);
    // Fast in, longer ease out.
    const age = 1 - this.pushLife / this.pushDuration;
    this.push = this.pushLife > 0 ? this.pushStrength * (age < 0.25 ? smooth(age / 0.25) : smooth((1 - age) / 0.75)) : 0;
    // The settle rides on a hair of zoom so the view it shifts never uncovers an edge.
    const settleK = this.settleLife > 0 ? Math.sin((1 - this.settleLife / FEEL.SETTLE_MS) * Math.PI) : 0;
    const zoom = 1 + this.push + settleK * (2.2 * FEEL.SETTLE_PX / SCREEN_H);
    const reach = (SCREEN_W - SCREEN_W / zoom) / 2;
    const reachY = (SCREEN_H - SCREEN_H / zoom) / 2;
    const lean = this.push > 0 ? Math.min(1, this.push / Math.max(0.001, this.pushStrength)) : 0;
    this.cam.setZoom(zoom);
    this.cam.setScroll(
      Math.max(-reach, Math.min(reach, this.aimX * 0.5 * lean)),
      Math.max(-reachY, Math.min(reachY, this.aimY * 0.5 * lean - settleK * FEEL.SETTLE_PX))
    );
    if (this.pushLife === 0 && this.settleLife === 0) {
      this.cam.setZoom(1);
      this.cam.setScroll(0, 0);
      this.dirty = false;
    }
  }

  /** A new race starts at the normal field of view, whatever the last one ended on. */
  resetDepth(): void {
    this.depthSent = 1;
    setCameraDepthScale(1);
  }

  /** Back to the normal view (scene restart, pause). */
  reset(): void {
    this.push = 0; this.pushLife = 0; this.settleLife = 0; this.boost = 0; this.boostTarget = 0; this.dirty = false;
    this.cam.setZoom(1);
    this.cam.setScroll(0, 0);
    if (this.depthSent !== 1) { this.depthSent = 1; setCameraDepthScale(1); }
  }
}
