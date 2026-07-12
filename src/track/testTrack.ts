import { SEGMENT_LENGTH } from '../config';
import { Segment } from './segment';

// Hard-coded placeholder track for Task 2: flat and straight (curve=0, y=0
// for every segment). Replaced by the seeded procedural generator in Task 5.
const TEST_TRACK_SEGMENT_COUNT = 500;

// Number of consecutive segments per alternating color band (snow shading /
// rumble strips). A few segments per band reads clearly as motion without
// flickering into noise.
const BAND_SIZE = 4;

export function buildTestTrack(): Segment[] {
  const segments: Segment[] = [];

  for (let index = 0; index < TEST_TRACK_SEGMENT_COUNT; index++) {
    segments.push({
      index,
      curve: 0,
      y: 0,
      z: index * SEGMENT_LENGTH,
      colorBand: Math.floor(index / BAND_SIZE) % 2 === 0 ? 0 : 1
    });
  }

  return segments;
}
