import { SCREEN_H, SCREEN_W, TOUCH_BUTTON, TOUCH_STEER } from '../config';

export type SteerDirection = -1 | 1;

/** One change the touch layer must apply through the input controller. */
export interface SteerOp {
  action: 'left' | 'right';
  down: boolean;
  /** Pointer id; the HUD turns it into the `touch:<id>` input source. */
  id: number;
}

/** Live area of the steer zones, including the overshoot past the screen edges. */
export function inSteerZone(x: number, y: number): boolean {
  return x >= -TOUCH_STEER.OVERSHOOT && x <= TOUCH_STEER.RIGHT_X
    && y >= TOUCH_STEER.TOP_Y && y <= SCREEN_H + TOUCH_STEER.OVERSHOOT;
}

/**
 * Direction for a finger at `x`. Left of the split is left, right of it is
 * right; inside the dead band around the split the finger keeps `previous`
 * (or, with none yet, goes by which side of the split it is on). The dead band
 * stops a thumb resting on the line from flickering between the two.
 */
export function steerDirectionAt(x: number, previous: SteerDirection | 0 = 0): SteerDirection {
  const { SPLIT_X, DEAD_BAND } = TOUCH_STEER;
  if (x < SPLIT_X - DEAD_BAND) return -1;
  if (x > SPLIT_X + DEAD_BAND) return 1;
  if (previous !== 0) return previous;
  return x < SPLIT_X ? -1 : 1;
}

const actionOf = (direction: SteerDirection): 'left' | 'right' => (direction < 0 ? 'left' : 'right');

/**
 * Pure state for steer-zone fingers. It owns no Phaser objects and no clock;
 * every call returns the presses and releases to send to the input controller.
 *
 *  - A press must start inside a zone. After that only the finger's x decides,
 *    and only while it is inside the live area: a finger that drifts out keeps
 *    its last direction until it lifts.
 *  - Sliding across the split releases the old direction and presses the new
 *    one in the same call, so one finger never holds both.
 *  - Only `release` (a lift, cancel, pause or blur) lets go.
 *  - One steering finger at a time: a newer finger takes over and the older one
 *    is dropped for good (it does not resume when the newer one lifts), so two
 *    thumbs can never hold both directions.
 */
export class SteerZoneTracker {
  private id: number | null = null;
  private direction: SteerDirection | 0 = 0;

  /** Direction currently held by the active finger, or 0. */
  get held(): SteerDirection | 0 { return this.direction; }
  /** Pointer id of the active finger, or null. */
  get pointerId(): number | null { return this.id; }

  press(id: number, x: number, y: number): SteerOp[] {
    if (!inSteerZone(x, y)) return [];
    // A newer finger takes over; a pointer id still held was missed by a release. Either way let go first.
    const ops = this.releaseAll();
    this.id = id;
    this.direction = steerDirectionAt(x);
    ops.push({ action: actionOf(this.direction), down: true, id });
    return ops;
  }

  move(id: number, x: number, y: number): SteerOp[] {
    if (id !== this.id || this.direction === 0 || !inSteerZone(x, y)) return [];
    const next = steerDirectionAt(x, this.direction);
    if (next === this.direction) return [];
    const ops: SteerOp[] = [
      { action: actionOf(this.direction), down: false, id },
      { action: actionOf(next), down: true, id }
    ];
    this.direction = next;
    return ops;
  }

  release(id: number): SteerOp[] {
    if (id !== this.id) return [];
    return this.releaseAll();
  }

  releaseAll(): SteerOp[] {
    if (this.id === null || this.direction === 0) { this.id = null; this.direction = 0; return []; }
    const op: SteerOp = { action: actionOf(this.direction), down: false, id: this.id };
    this.id = null;
    this.direction = 0;
    return [op];
  }
}

/** Sends steer ops through the input controller's `control(action, down, source)` path.
 *  A press first clears any stale hold under the same pointer id: a release that never
 *  arrived would otherwise make the controller ignore this press as a repeat. */
export function applySteerOps(
  ops: readonly SteerOp[],
  control: (action: 'left' | 'right', down: boolean, source: string) => void
): void {
  for (const op of ops) {
    const source = `touch:${op.id}`;
    if (op.down) control(op.action, false, source);
    control(op.action, op.down, source);
  }
}

export interface TouchHitArea { left: number; right: number; top: number; bottom: number }

/** Live areas for the right-hand buttons, keyed by face centre x. Each reaches up past its
 *  face and down/right past the screen edges, and neighbours meet half-way across the gap so
 *  no two overlap. */
export function touchHitAreas(centers: readonly number[]): TouchHitArea[] {
  const half = TOUCH_BUTTON.FACE_W / 2;
  const top = TOUCH_BUTTON.CENTER_Y - TOUCH_BUTTON.FACE_H / 2 - TOUCH_BUTTON.PAD_UP;
  const bottom = SCREEN_H + TOUCH_BUTTON.PAD_OUT;
  return centers.map((cx, i) => {
    const prev = centers[i - 1], next = centers[i + 1];
    return {
      left: prev === undefined ? cx - half - TOUCH_BUTTON.PAD_SIDE : (prev + cx) / 2,
      right: next === undefined ? SCREEN_W + TOUCH_BUTTON.PAD_OUT : (cx + next) / 2,
      top, bottom
    };
  });
}
