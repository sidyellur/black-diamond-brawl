import { SEGMENT_LENGTH } from '../config';
import { easeIn, easeInOut, easeOut } from './easing';
import { Segment } from './segment';

// Number of consecutive segments per alternating color band (snow shading /
// rumble strips). A few segments per band reads clearly as motion without
// flickering into noise.
const BAND_SIZE = 4;

// Curve strengths (units are world-X offset accumulated per segment by the
// §3.3 offset walk). Tuned so a full curve section visibly bends the road
// without whipping it off screen.
const CURVE_MEDIUM = 0.5;
const CURVE_STRONG = 0.8;

// Hill/crest elevations in world-Y (same units as CAMERA_HEIGHT = 1000). A
// crest is a taller, sharper peak so it actually clips the road behind it.
const HILL_HEIGHT = 2200;
const CREST_HEIGHT = 4200;

/**
 * Hard-coded sampler track that exercises every renderer feature added in
 * Task 3: a left curve, a right curve, an S-curve, a hill up, a hill down,
 * and a sharp crest that hides the road behind it. Enough straight track sits
 * between features to read each one clearly at the auto-scroll speed.
 *
 * The track begins and ends flat (curve 0, y 0) so it loops seamlessly when
 * `camZ` wraps back to the start.
 */
export function buildSamplerTrack(): Segment[] {
  const segments: Segment[] = [];
  let lastY = 0;

  const push = (curve: number, y: number): void => {
    const index = segments.length;
    segments.push({
      index,
      curve,
      y,
      z: index * SEGMENT_LENGTH,
      colorBand: Math.floor(index / BAND_SIZE) % 2 === 0 ? 0 : 1,
    });
    lastY = y;
  };

  const addStraight = (count: number): void => {
    const y = lastY;
    for (let i = 0; i < count; i++) {
      push(0, y);
    }
  };

  // Curve section: ramp the curve 0 -> `curve` over `enter`, hold it across
  // `hold`, then ramp back to 0 over `leave`. Elevation is held flat.
  const addCurve = (enter: number, hold: number, leave: number, curve: number): void => {
    const y = lastY;
    for (let i = 0; i < enter; i++) {
      push(easeIn(0, curve, (i + 1) / enter), y);
    }
    for (let i = 0; i < hold; i++) {
      push(curve, y);
    }
    for (let i = 0; i < leave; i++) {
      push(easeOut(curve, 0, (i + 1) / leave), y);
    }
  };

  // Hill section: cosine-ease the elevation from the current elevation to
  // `startY + height` across the whole section. Curve is held straight.
  const addHill = (enter: number, hold: number, leave: number, height: number): void => {
    const startY = lastY;
    const endY = startY + height;
    const total = enter + hold + leave;
    let done = 0;
    for (let phase = 0; phase < 3; phase++) {
      const count = phase === 0 ? enter : phase === 1 ? hold : leave;
      for (let i = 0; i < count; i++) {
        done++;
        push(0, easeInOut(startY, endY, done / total));
      }
    }
  };

  addStraight(30); // readable lead-in

  addCurve(20, 30, 20, -CURVE_MEDIUM); // left curve
  addStraight(30);
  addCurve(20, 30, 20, CURVE_MEDIUM); // right curve
  addStraight(30);

  // S-curve: a right curve flowing straight into a left curve.
  addCurve(15, 20, 15, CURVE_STRONG);
  addCurve(15, 20, 15, -CURVE_STRONG);
  addStraight(40);

  addHill(20, 25, 20, HILL_HEIGHT); // hill up
  addStraight(25);
  addHill(20, 25, 20, -HILL_HEIGHT); // hill down, back to flat
  addStraight(40);

  // Crest: a sharp peak up then straight back down, tall enough to hide the
  // descending road behind it until the camera crests it.
  addHill(15, 8, 15, CREST_HEIGHT);
  addHill(15, 8, 15, -CREST_HEIGHT);
  addStraight(60); // long flat run-out; ends at y 0 for a seamless loop

  return segments;
}
