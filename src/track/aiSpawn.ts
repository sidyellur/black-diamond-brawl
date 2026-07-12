import {
  AI_AGGRESSION_MAX,
  AI_AGGRESSION_MIN,
  AI_CRUISE_SPEED_MAX_FACTOR,
  AI_CRUISE_SPEED_MIN_FACTOR,
  AI_REACTION_DISTANCE_MAX_SEGMENTS,
  AI_REACTION_DISTANCE_MIN_SEGMENTS,
  AI_RIDER_COUNT,
  AI_START_LANES,
  AI_START_Z_OFFSETS_SEGMENTS,
  SEGMENT_LENGTH
} from '../config';
import { AIRiderParams } from '../entities/aiRider';
import { Prng } from './prng';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Draws the AI riders' per-rider parameters (design-spec §4.5) from the SAME
 * seeded `prng` the geometry and obstacle placement passes already advanced.
 * Must be called strictly after `placeObstacles` — still before
 * `generateTrack` returns the same `prng` instance, never a second,
 * separately-seeded one — so the whole course (geometry, obstacles, AND
 * rivals) stays fully deterministic per seed (§4.2's two-pass discipline,
 * extended here to a third draw-order-fixed step).
 *
 * Start lane/Z are a fixed stagger layout, not RNG-drawn — the spec only
 * calls out cruise speed/aggression/reaction distance as the seeded
 * per-rider set (§4.5); "staggered around the player at the start line" just
 * needs a sensible fixed layout.
 */
export function spawnAIRiders(prng: Prng): AIRiderParams[] {
  const params: AIRiderParams[] = [];
  for (let i = 0; i < AI_RIDER_COUNT; i++) {
    const cruiseSpeedFactor = lerp(AI_CRUISE_SPEED_MIN_FACTOR, AI_CRUISE_SPEED_MAX_FACTOR, prng());
    const aggression = lerp(AI_AGGRESSION_MIN, AI_AGGRESSION_MAX, prng());
    const reactionDistanceSegments = lerp(
      AI_REACTION_DISTANCE_MIN_SEGMENTS,
      AI_REACTION_DISTANCE_MAX_SEGMENTS,
      prng()
    );
    params.push({
      cruiseSpeedFactor,
      aggression,
      reactionDistanceSegments,
      startLane: AI_START_LANES[i],
      startZOffset: AI_START_Z_OFFSETS_SEGMENTS[i] * SEGMENT_LENGTH,
      paletteIndex: i
    });
  }
  return params;
}
