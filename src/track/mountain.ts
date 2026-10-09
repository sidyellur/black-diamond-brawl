import { SEGMENT_LENGTH } from '../config';
import type { Segment } from './segment';

/** Increment when geometry or placement changes make previous runs incomparable. */
export const MOUNTAIN_GENERATOR_VERSION = 2;

export type MountainTheme = 'forest' | 'ridge' | 'bowl';
export type MountainSetpiece =
  | 'warmup' | 'runout'
  | 'needle-slalom' | 'timber-chicane' | 'cedar-switchbacks'
  | 'eagle-flight' | 'knife-edge' | 'cloud-step'
  | 'powder-arena' | 'glacier-cirque' | 'sunburst-basin';
export type MountainSafeZone = 'warmup' | 'transition' | 'takeoff' | 'landing' | 'combat' | 'runout';

export interface MountainSection {
  id: string;
  name: string;
  theme: MountainTheme;
  startSegment: number;
  /** Exclusive end, so every segment belongs to exactly one section. */
  endSegment: number;
  setpiece: MountainSetpiece;
  /** Course difficulty, 0..1. Geometry and obstacle pacing share this value. */
  intensity: number;
}

export const MOUNTAIN_SETPIECES: Record<MountainTheme, readonly { id: MountainSetpiece; name: string }[]> = {
  forest: [
    { id: 'needle-slalom', name: 'Pine Needle Slalom' },
    { id: 'timber-chicane', name: 'Timberline Chicane' },
    { id: 'cedar-switchbacks', name: 'Cedar Switchbacks' }
  ],
  ridge: [
    { id: 'eagle-flight', name: 'Eagle Flight Ridge' },
    { id: 'knife-edge', name: 'Knife-Edge Traverse' },
    { id: 'cloud-step', name: 'Cloudstep Ridge' }
  ],
  bowl: [
    { id: 'powder-arena', name: 'Powder Arena' },
    { id: 'glacier-cirque', name: 'Glacier Cirque' },
    { id: 'sunburst-basin', name: 'Sunburst Basin' }
  ]
};

/** HUD/cup read API. Clamped rather than looped: generated mountains have a finish. */
export function sectionAtZ(sections: readonly MountainSection[], worldZ: number): MountainSection | undefined {
  if (sections.length === 0 || !Number.isFinite(worldZ)) return undefined;
  const segment = Math.max(0, Math.floor(worldZ / SEGMENT_LENGTH));
  let lo = 0;
  let hi = sections.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (segment < sections[mid].endSegment) hi = mid;
    else lo = mid + 1;
  }
  return sections[lo];
}

/** Legacy/sampler segments retain their original forest scenery. */
export function themeAtSegment(segment: Pick<Segment, 'theme'> | undefined): MountainTheme {
  return segment?.theme ?? 'forest';
}
