// A single slice of road (design-spec §3.1).
//
// `curve` and `y` are carried here for Task 3 (curves/hills) but are unused
// by this task's flat, straight test track (always curve=0, y=0).
export interface Segment {
  /** Position of this segment in the track array. */
  index: number;
  /** Signed curve strength (negative = left, positive = right). Unused until Task 3. */
  curve: number;
  /** World elevation at the segment's far edge. Unused until Task 3. */
  y: number;
  /** World-Z of the segment's near edge (`index * SEGMENT_LENGTH`). */
  z: number;
  /** Alternates every few segments to drive alternating snow/rumble shading. */
  colorBand: 0 | 1;
}
