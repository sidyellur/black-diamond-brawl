import { COURSE_LENGTH_SEGMENTS } from '../config';
import { mulberry32, Prng } from './prng';
import { addCurve, addHill, addStraight, createBuilder, pushSegment, TrackBuilder } from './sections';
import { Segment } from './segment';

// First segments are a flat, obstacle-free warm-up (design-spec §4.2)
// before the geometry pass starts drawing random sections.
const WARMUP_SEGMENTS = 100;

// Short obstacle-free run-out straight immediately before the finish line.
const RUNOUT_SEGMENTS = 40;

// A dedicated wind-down hill that eases elevation back to 0 right before the
// run-out. This isn't in the spec as a named feature, but it buys two things
// cheaply: it makes the course begin and end flat/level (same convention
// `testTrack.ts` used, "begins and ends flat... so it loops seamlessly"),
// which (a) means the renderer's `(segIndex - 1 + len) % len` near-edge
// lookup for segment 0 (which reads the *last* segment's elevation) can
// never produce a visible seam at the start line, and (b) means the
// finish/run-out reads as a clean, level approach to the banner regardless
// of how much net elevation the random hills accumulated.
const RETURN_TO_FLAT_SEGMENTS = 60;

// Below this many remaining segments, a curve/hill section's ramp-in/hold/
// ramp-out shape can't be scaled down meaningfully — the geometry pass just
// pads with a plain straight instead. Keeping this small (rather than the
// widest section's full footprint) matters for the difficulty ramp: it's
// what keeps sharp curves showing up right up to the edge of the reserved
// tail instead of the pass bailing out into flat straight well before t→1.
const MIN_VIABLE_SECTION = 6;

const CURVE_GENTLE = 0.35;
const CURVE_SHARP = 0.8;
const HILL_HEIGHT = 1800;
const CREST_HEIGHT = 4000;

type SectionType =
  | 'straight'
  | 'curveGentleL'
  | 'curveGentleR'
  | 'curveSharpL'
  | 'curveSharpR'
  | 'sCurve'
  | 'hillUp'
  | 'hillDown'
  | 'crest';

// Difficulty ramp (design-spec §4.2): weighted section choice interpolates
// from the START table (t=0, easy) to the END table (t=1, hard) as the
// course progresses. Straights get rarer and shorter, sharp curves and
// S-curves get much more common.
const WEIGHTS_START: Record<SectionType, number> = {
  straight: 42,
  curveGentleL: 16,
  curveGentleR: 16,
  curveSharpL: 2,
  curveSharpR: 2,
  sCurve: 4,
  hillUp: 8,
  hillDown: 8,
  crest: 2
};

const WEIGHTS_END: Record<SectionType, number> = {
  straight: 8,
  curveGentleL: 10,
  curveGentleR: 10,
  curveSharpL: 22,
  curveSharpR: 22,
  sCurve: 12,
  hillUp: 6,
  hillDown: 6,
  crest: 4
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const randInt = (prng: Prng, min: number, max: number): number => Math.floor(min + prng() * (max - min + 1));

function pickSectionType(prng: Prng, t: number): SectionType {
  const types = Object.keys(WEIGHTS_START) as SectionType[];
  const weights = types.map((type) => Math.max(0, lerp(WEIGHTS_START[type], WEIGHTS_END[type], t)));
  const total = weights.reduce((sum, w) => sum + w, 0);

  let roll = prng() * total;
  for (let i = 0; i < types.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      return types[i];
    }
  }
  return types[types.length - 1]; // floating-point fallback
}

/**
 * Scales `[enter, hold, leave]` down to sum to exactly `maxTotal` when they
 * would otherwise overshoot it, shrinking `hold` first (a curve/hill still
 * reads fine held for less time) and only eating into `enter`/`leave` (kept
 * at a minimum of 1 each) once `hold` alone can't absorb the cut. Used so a
 * section picked near the end of the geometry pass's budget still fits
 * exactly instead of being dropped in favor of a plain straight — that
 * would otherwise blunt the difficulty ramp right when curves should be
 * most frequent (t→1).
 */
function capLengths(enter: number, hold: number, leave: number, maxTotal: number): [number, number, number] {
  const total = enter + hold + leave;
  if (total <= maxTotal) {
    return [enter, hold, leave];
  }
  const scale = maxTotal / total;
  let e = Math.max(1, Math.round(enter * scale));
  let l = Math.max(1, Math.round(leave * scale));
  if (e + l > maxTotal) {
    const edgeScale = maxTotal / (e + l);
    e = Math.max(1, Math.floor(e * edgeScale));
    l = Math.max(1, maxTotal - e);
  }
  const h = Math.max(0, maxTotal - e - l);
  return [e, h, l];
}

/** Appends one section of `type`, capped to fit within `maxTotal` segments,
 *  and returns how many segments it actually added. */
function appendSection(builder: TrackBuilder, type: SectionType, t: number, prng: Prng, maxTotal: number): number {
  switch (type) {
    case 'straight': {
      // Straights shrink from ~45-70 segments at t=0 down to ~15-30 at t=1.
      const long = randInt(prng, 45, 70);
      const short = randInt(prng, 15, 30);
      return addStraight(builder, Math.min(maxTotal, Math.round(lerp(long, short, t))));
    }
    case 'curveGentleL': {
      const [e, h, l] = capLengths(randInt(prng, 15, 22), randInt(prng, 20, 30), randInt(prng, 15, 22), maxTotal);
      return addCurve(builder, -CURVE_GENTLE, e, h, l);
    }
    case 'curveGentleR': {
      const [e, h, l] = capLengths(randInt(prng, 15, 22), randInt(prng, 20, 30), randInt(prng, 15, 22), maxTotal);
      return addCurve(builder, CURVE_GENTLE, e, h, l);
    }
    case 'curveSharpL': {
      const [e, h, l] = capLengths(randInt(prng, 12, 18), randInt(prng, 18, 26), randInt(prng, 12, 18), maxTotal);
      return addCurve(builder, -CURVE_SHARP, e, h, l);
    }
    case 'curveSharpR': {
      const [e, h, l] = capLengths(randInt(prng, 12, 18), randInt(prng, 18, 26), randInt(prng, 12, 18), maxTotal);
      return addCurve(builder, CURVE_SHARP, e, h, l);
    }
    case 'sCurve': {
      const direction = prng() < 0.5 ? 1 : -1;
      const magnitude = t < 0.5 ? CURVE_GENTLE : CURVE_SHARP;
      const halfBudget = Math.floor(maxTotal / 2);
      const [e1, h1, l1] = capLengths(randInt(prng, 12, 18), randInt(prng, 16, 22), randInt(prng, 12, 18), halfBudget);
      const [e2, h2, l2] = capLengths(randInt(prng, 12, 18), randInt(prng, 16, 22), randInt(prng, 12, 18), maxTotal - halfBudget);
      const first = addCurve(builder, direction * magnitude, e1, h1, l1);
      const second = addCurve(builder, -direction * magnitude, e2, h2, l2);
      return first + second;
    }
    case 'hillUp': {
      const height = randInt(prng, Math.round(HILL_HEIGHT * 0.6), Math.round(HILL_HEIGHT * 1.2));
      const [e, h, l] = capLengths(randInt(prng, 18, 24), randInt(prng, 20, 28), randInt(prng, 18, 24), maxTotal);
      return addHill(builder, height, e, h, l);
    }
    case 'hillDown': {
      const height = randInt(prng, Math.round(HILL_HEIGHT * 0.6), Math.round(HILL_HEIGHT * 1.2));
      const [e, h, l] = capLengths(randInt(prng, 18, 24), randInt(prng, 20, 28), randInt(prng, 18, 24), maxTotal);
      return addHill(builder, -height, e, h, l);
    }
    case 'crest': {
      const halfBudget = Math.floor(maxTotal / 2);
      const [e1, h1, l1] = capLengths(randInt(prng, 12, 16), randInt(prng, 6, 10), randInt(prng, 12, 16), halfBudget);
      const [e2, h2, l2] = capLengths(randInt(prng, 12, 16), randInt(prng, 6, 10), randInt(prng, 12, 16), maxTotal - halfBudget);
      const up = addHill(builder, CREST_HEIGHT, e1, h1, l1);
      const down = addHill(builder, -CREST_HEIGHT, e2, h2, l2);
      return up + down;
    }
  }
}

/**
 * Runs the full geometry pass (section layout, curves, hills — design-spec
 * §4.2) against an already-constructed `prng`, drawing from it start to
 * finish before returning. Exported separately from `generateTrack` (rather
 * than folding `mulberry32(seed)` in here) so Tasks 6-8 can run this pass,
 * then keep drawing from that exact same `prng` instance for their
 * placement pass (obstacles, pickups, AI parameters) — genuinely the "two
 * strictly ordered passes over the seeded PRNG" the spec calls for, not two
 * separately-seeded generators. This task adds no placement logic itself,
 * not even a stub, to keep that boundary clean for those tasks to slot
 * into: they call this function once, then own everything drawn from
 * `prng` afterward.
 */
export function buildGeometry(prng: Prng): Segment[] {
  const builder = createBuilder();

  // Warm-up: flat, straight, obstacle-free (§4.2).
  addStraight(builder, WARMUP_SEGMENTS);

  // Reserve the tail budget (wind-down + run-out + the finish segment
  // itself) up front so the geometry loop below can never overshoot it.
  const targetBeforeReturn = COURSE_LENGTH_SEGMENTS - RETURN_TO_FLAT_SEGMENTS - RUNOUT_SEGMENTS - 1;

  while (builder.segments.length < targetBeforeReturn) {
    const remaining = targetBeforeReturn - builder.segments.length;
    if (remaining < MIN_VIABLE_SECTION) {
      addStraight(builder, remaining);
      break;
    }
    const t = builder.segments.length / COURSE_LENGTH_SEGMENTS;
    const type = pickSectionType(prng, t);
    appendSection(builder, type, t, prng, remaining);
  }

  // Ease elevation back to 0 so the course is level at both ends.
  const enter = Math.round(RETURN_TO_FLAT_SEGMENTS * 0.35);
  const hold = Math.round(RETURN_TO_FLAT_SEGMENTS * 0.3);
  const leave = RETURN_TO_FLAT_SEGMENTS - enter - hold;
  addHill(builder, -builder.lastY, enter, hold, leave);

  // Obstacle-free run-out, then the finish line itself (§4.2).
  addStraight(builder, RUNOUT_SEGMENTS);
  pushSegment(builder, 0, builder.lastY, true);

  return builder.segments;
}

/**
 * Generates the full ~`COURSE_LENGTH_SEGMENTS`-long course for a seed: the
 * convenience entry point this task's `RaceScene` uses, when there's no
 * placement pass to chain afterward yet. Just seeds a `prng` and runs the
 * geometry pass to completion.
 */
export function generateTrack(seed: number): Segment[] {
  return buildGeometry(mulberry32(seed));
}
