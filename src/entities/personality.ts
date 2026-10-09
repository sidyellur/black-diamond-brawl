/** Gameplay traits are explicit so names, lessons and AI share one definition. */
export type RivalPersonality = 'bully' | 'line-defender' | 'daredevil';

export interface PersonalityDefinition {
  readonly name: string;
  readonly glyph: string;
  readonly lesson: string;
  readonly windupMs: number;
  readonly recoveryMs: number;
  readonly aggressionMultiplier: number;
  readonly attackIntervalMs: number;
}

export const PERSONALITIES: Record<RivalPersonality, PersonalityDefinition> = {
  bully: {
    name: 'BULLY', glyph: '!',
    lesson: 'Bully follows your lane. Wait for the tell, then steer or jump and Attack to counter.',
    windupMs: 640, recoveryMs: 1050, aggressionMultiplier: 1.6, attackIntervalMs: 750
  },
  'line-defender': {
    name: 'DEFENDER', glyph: '=',
    lesson: 'Defender guards its starting lane. Pass on another line, or bait a strike and counter.',
    windupMs: 720, recoveryMs: 1150, aggressionMultiplier: 1, attackIntervalMs: 950
  },
  daredevil: {
    name: 'DAREDEVIL', glyph: '^',
    lesson: 'Daredevil seeks rocks and moguls. Stay below its jump; avoid matching its aerial line.',
    windupMs: 560, recoveryMs: 1100, aggressionMultiplier: 0.85, attackIntervalMs: 1000
  }
};

export const PERSONALITY_ORDER: readonly RivalPersonality[] = ['bully', 'line-defender', 'daredevil'];

/** Hash a course-derived seed with rider identity, without sharing a mutable
 * stream with another rival, rendering, audio, or obstacle generation. */
export function deriveRiderSeed(courseWord: number, riderIndex: number): number {
  let seed = (courseWord ^ Math.imul(riderIndex + 1, 0x9e3779b9)) >>> 0;
  seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b);
  return (seed ^ (seed >>> 13)) >>> 0;
}
