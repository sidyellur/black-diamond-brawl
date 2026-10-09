import { BLIND_LANDING_SEGMENTS, COURSE_LENGTH_SEGMENTS } from '../config';
import { AIRiderParams } from '../entities/aiRider';
import { Obstacle } from '../entities/obstacle';
import { Pickup } from '../entities/pickup';
import { spawnAIRiders } from './aiSpawn';
import { MOUNTAIN_GENERATOR_VERSION, MOUNTAIN_SETPIECES, MountainSection, MountainTheme } from './mountain';
import { placeObstacles } from './placement';
import { placePickups } from './pickupPlacement';
import { mulberry32, Prng, randInt } from './prng';
import { addCurve, addHill, addStraight, createBuilder, pushSegment, TrackBuilder } from './sections';
import { Segment } from './segment';

const WARMUP_SEGMENTS = 100;
const RUNOUT_SEGMENTS = 40;
const RETURN_TO_FLAT_SEGMENTS = 60;
const TRANSITION_SEGMENTS = 10;

export interface GeometryResult {
  segments: Segment[];
  crestApexes: number[];
  sections: MountainSection[];
  placeableStart: number;
  placeableEnd: number;
}

/** Divide an exact budget into seeded pieces, never allowing a truncated crest. */
function divideBudget(total: number, weights: number[]): number[] {
  const sum = weights.reduce((n, value) => n + value, 0);
  let consumed = 0;
  return weights.map((value, i) => {
    const count = i === weights.length - 1 ? total - consumed : Math.floor(total * value / sum);
    consumed += count;
    return count;
  });
}

/** All curves meet at zero curvature, so transitions never snap the road. */
function curve(builder: TrackBuilder, strength: number, length: number): void {
  const enter = Math.floor(length * 0.3);
  const leave = Math.floor(length * 0.3);
  addCurve(builder, strength, enter, length - enter - leave, leave);
}

function hill(builder: TrackBuilder, height: number, length: number): void {
  const edge = Math.floor(length / 3);
  addHill(builder, height, edge, length - edge * 2, edge);
}

function addForest(builder: TrackBuilder, budget: number, variant: number, intensity: number, prng: Prng): void {
  // The gates follow the bends. Their clear pair alternates left/right, giving
  // forest sections a real carve rhythm, not just a different background.
  const turns = variant === 1 ? 6 : variant === 2 ? 4 : 8;
  const lengths = divideBudget(budget, Array.from({ length: turns }, () => randInt(prng, 8, 12)));
  const direction = prng() < 0.5 ? -1 : 1;
  for (let turn = 0; turn < turns; turn++) {
    const sign = direction * (turn % 2 === 0 ? 1 : -1);
    const start = builder.segments.length;
    curve(builder, sign * (0.4 + intensity * 0.37 + prng() * 0.07), lengths[turn]);
    for (let i = start; i < builder.segments.length; i++) builder.segments[i].slalomLane = sign > 0 ? 3 : 1;
  }
}

function addRidge(builder: TrackBuilder, budget: number, variant: number, intensity: number,
  prng: Prng, crestApexes: number[]): void {
  // Knife Edge is one big exposed launch; the other ridges are two-step
  // flights, with a complete landing and steering recovery between jumps.
  const flights = variant === 1 ? 1 : 2;
  const lengths = divideBudget(budget, Array.from({ length: flights }, () => randInt(prng, 9, 11)));
  for (const length of lengths) {
    const rise = Math.floor(length * (flights === 1 ? 0.28 : 0.34));
    const fall = Math.max(BLIND_LANDING_SEGMENTS + 6, Math.floor(length * 0.37));
    const height = 2200 + intensity * 1200 + randInt(prng, 0, 650);
    hill(builder, height, rise);
    const apex = builder.segments.length - 1;
    crestApexes.push(apex);
    hill(builder, -height, fall);
    const exit = length - rise - fall;
    curve(builder, (prng() < 0.5 ? -1 : 1) * (0.2 + intensity * 0.15), exit);
    // Launch approach is readable. Landing protection is also independently
    // enforced by placement and tested against actual crest indices.
    for (let i = Math.max(0, apex - 9); i < apex; i++) builder.segments[i].safeZone = 'takeoff';
    for (let i = apex; i <= apex + BLIND_LANDING_SEGMENTS; i++) builder.segments[i].safeZone = 'landing';
  }
}

function addBowl(builder: TrackBuilder, budget: number, variant: number, intensity: number, prng: Prng): void {
  const entry = Math.floor(budget * 0.22);
  const arena = Math.floor(budget * (variant === 0 ? 0.52 : 0.44));
  const exit = budget - entry - arena;
  hill(builder, -(650 + randInt(prng, 0, 550)), entry);
  const clearStart = builder.segments.length;
  // Long uninterrupted sightlines plus all five obstacle-free lanes make a
  // deliberate space for overtakes, attacks and recovery between hard gates.
  addStraight(builder, arena);
  for (let i = clearStart; i < builder.segments.length; i++) builder.segments[i].safeZone = 'combat';
  curve(builder, (prng() < 0.5 ? -1 : 1) * (0.12 + intensity * 0.15), exit);
}

/**
 * Deliberate mountain structure with seeded variations inside it. Two acts of
 * forest -> ridge -> bowl guarantee all three riding rhythms on EVERY seed.
 * Geometry completes before any obstacle/pickup/rival draws, as before.
 */
export function buildGeometry(prng: Prng): GeometryResult {
  const builder = createBuilder();
  const crestApexes: number[] = [];
  const sections: MountainSection[] = [];
  const addMetadata = (section: MountainSection): void => {
    const sectionIndex = sections.length;
    sections.push(section);
    for (let i = section.startSegment; i < section.endSegment; i++) {
      Object.assign(builder.segments[i], { sectionIndex, theme: section.theme, setpiece: section.setpiece });
    }
  };

  addStraight(builder, WARMUP_SEGMENTS);
  for (const segment of builder.segments) segment.safeZone = 'warmup';
  addMetadata({ id: 'summit-start', name: 'Summit Lodge', theme: 'forest', setpiece: 'warmup',
    startSegment: 0, endSegment: WARMUP_SEGMENTS, intensity: 0 });
  const placeableStart = builder.segments.length;
  const placeableEnd = COURSE_LENGTH_SEGMENTS - RETURN_TO_FLAT_SEGMENTS - RUNOUT_SEGMENTS - 1;
  const lengths = divideBudget(placeableEnd - placeableStart, Array.from({ length: 6 }, () => randInt(prng, 190, 230)));
  const previousVariant: Partial<Record<MountainTheme, number>> = {};
  const themes: MountainTheme[] = ['forest', 'ridge', 'bowl', 'forest', 'ridge', 'bowl'];
  for (let stage = 0; stage < themes.length; stage++) {
    const theme = themes[stage];
    const startSegment = builder.segments.length;
    const intensity = startSegment / COURSE_LENGTH_SEGMENTS;
    let variant = randInt(prng, 0, 2);
    if (variant === previousVariant[theme]) variant = (variant + 1 + randInt(prng, 0, 1)) % 3;
    previousVariant[theme] = variant;
    const feature = MOUNTAIN_SETPIECES[theme][variant];
    addStraight(builder, TRANSITION_SEGMENTS);
    const budget = lengths[stage] - TRANSITION_SEGMENTS * 2;
    if (theme === 'forest') addForest(builder, budget, variant, intensity, prng);
    else if (theme === 'ridge') addRidge(builder, budget, variant, intensity, prng, crestApexes);
    else addBowl(builder, budget, variant, intensity, prng);
    addStraight(builder, TRANSITION_SEGMENTS);
    const endSegment = builder.segments.length;
    for (let i = 0; i < TRANSITION_SEGMENTS; i++) {
      builder.segments[startSegment + i].safeZone = 'transition';
      builder.segments[endSegment - 1 - i].safeZone = 'transition';
    }
    addMetadata({ id: `${theme}-${stage}-${feature.id}`, name: feature.name, theme,
      setpiece: feature.id, startSegment, endSegment, intensity });
  }

  hill(builder, -builder.lastY, RETURN_TO_FLAT_SEGMENTS);
  addStraight(builder, RUNOUT_SEGMENTS);
  pushSegment(builder, 0, builder.lastY, true);
  for (let i = placeableEnd; i < builder.segments.length; i++) builder.segments[i].safeZone = 'runout';
  addMetadata({ id: 'finish-runout', name: 'Valley Finish', theme: 'bowl', setpiece: 'runout',
    startSegment: placeableEnd, endSegment: builder.segments.length, intensity: 1 });
  return { segments: builder.segments, crestApexes, sections, placeableStart, placeableEnd };
}

export interface GeneratedTrack {
  generatorVersion: number;
  sections: MountainSection[];
  segments: Segment[];
  obstacles: Obstacle[];
  crestApexes: number[];
  aiRiders: AIRiderParams[];
  pickups: Pickup[];
}

/** One seed, four strictly ordered passes, no runtime randomness. */
export function generateTrack(seed: number): GeneratedTrack {
  const prng = mulberry32(seed);
  const geometry = buildGeometry(prng);
  const obstacles = placeObstacles(geometry, prng);
  const pickups = placePickups({ obstacles, placeableStart: geometry.placeableStart,
    placeableEnd: geometry.placeableEnd }, prng);
  const aiRiders = spawnAIRiders(prng);
  return { generatorVersion: MOUNTAIN_GENERATOR_VERSION, sections: geometry.sections,
    segments: geometry.segments, obstacles, crestApexes: geometry.crestApexes, aiRiders, pickups };
}
