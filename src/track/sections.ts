import { SEGMENT_LENGTH } from '../config';
import { easeIn, easeInOut, easeOut } from './easing';
import { Segment } from './segment';

// Number of consecutive segments per alternating color band — same value
// and purpose as the sampler track's (`testTrack.ts`).
const BAND_SIZE = 4;

/**
 * Accumulates segments for the procedural generator (mirrors the local
 * push/lastY bookkeeping `testTrack.ts` does inline, factored out here so
 * `generator.ts` can stitch many sections from the pattern library below).
 */
export interface TrackBuilder {
  segments: Segment[];
  lastY: number;
}

export function createBuilder(): TrackBuilder {
  return { segments: [], lastY: 0 };
}

export function pushSegment(builder: TrackBuilder, curve: number, y: number, isFinish = false): void {
  const index = builder.segments.length;
  builder.segments.push({
    index,
    curve,
    y,
    z: index * SEGMENT_LENGTH,
    colorBand: Math.floor(index / BAND_SIZE) % 2 === 0 ? 0 : 1,
    isFinish
  });
  builder.lastY = y;
}

/** Flat, straight run of `count` segments at the current elevation. Returns
 *  the number of segments appended (always `count`) so callers can track
 *  exact remaining length budget. */
export function addStraight(builder: TrackBuilder, count: number): number {
  const y = builder.lastY;
  for (let i = 0; i < count; i++) {
    pushSegment(builder, 0, y);
  }
  return count;
}

/** Curve section: ramp the curve 0 -> `curve` over `enter`, hold it across
 *  `hold`, then ramp back to 0 over `leave` (same ramp-in/hold/ramp-out
 *  shape as `testTrack.ts`'s `addCurve`). Elevation is held flat. Always
 *  returns to curve 0, so sections always compose cleanly back-to-back. */
export function addCurve(builder: TrackBuilder, curve: number, enter: number, hold: number, leave: number): number {
  const y = builder.lastY;
  for (let i = 0; i < enter; i++) {
    pushSegment(builder, easeIn(0, curve, (i + 1) / enter), y);
  }
  for (let i = 0; i < hold; i++) {
    pushSegment(builder, curve, y);
  }
  for (let i = 0; i < leave; i++) {
    pushSegment(builder, easeOut(curve, 0, (i + 1) / leave), y);
  }
  return enter + hold + leave;
}

/** S-curve: one curve section flowing straight into the mirrored curve in
 *  the opposite direction — same composition `testTrack.ts` used for its
 *  sampler S-curve (two back-to-back `addCurve` calls of opposite sign). */
export function addSCurve(builder: TrackBuilder, curve: number, enter: number, hold: number, leave: number): number {
  const first = addCurve(builder, curve, enter, hold, leave);
  const second = addCurve(builder, -curve, enter, hold, leave);
  return first + second;
}

/** Hill (or crest, or the final return-to-flat wind-down) section: cosine
 *  ease the elevation from the current elevation to `startY + height` across
 *  the whole section (identical shape to `testTrack.ts`'s `addHill`). Curve
 *  is held straight throughout. */
export function addHill(builder: TrackBuilder, height: number, enter: number, hold: number, leave: number): number {
  const startY = builder.lastY;
  const endY = startY + height;
  const total = enter + hold + leave;
  let done = 0;
  for (let phase = 0; phase < 3; phase++) {
    const count = phase === 0 ? enter : phase === 1 ? hold : leave;
    for (let i = 0; i < count; i++) {
      done++;
      pushSegment(builder, 0, easeInOut(startY, endY, done / total));
    }
  }
  return total;
}
