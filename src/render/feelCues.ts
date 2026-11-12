import type { SoundKind } from '../audio/effects';

/**
 * Turns one simulation step's combat events into one cue per struck rider, so
 * a hit reads by weight: a plain hit, a pole hit, a counter, a shove, a
 * snowball, a knockdown and a rider put into a tree each get their own sound
 * and their own camera response. Pure and read-only: it looks at events the
 * simulation already produced and changes nothing.
 */
export type CombatCueKind = 'brush' | 'hit' | 'pole' | 'counter' | 'push' | 'snowball' | 'knockdown' | 'treeKnockout';

export interface CueEvent { type: 'hit' | 'brush' | 'knockout' | 'push'; rider: { knockedDown: boolean } }
export interface CombatCue<R> { kind: CombatCueKind; rider: R }

export const CUE_SOUND: Record<CombatCueKind, SoundKind> = {
  brush: 'hit', hit: 'hit', pole: 'poleHit', counter: 'counter', push: 'shove',
  snowball: 'snowImpact', knockdown: 'knockdown', treeKnockout: 'treeKnockout'
};
/** 0..1 weight: scales shake, sparks and rings. */
export const CUE_WEIGHT: Record<CombatCueKind, number> = {
  brush: 0.2, snowball: 0.25, push: 0.45, hit: 0.55, pole: 0.8, counter: 0.9, knockdown: 1, treeKnockout: 1
};
/** Sound intensity per cue. */
export const CUE_LEVEL: Record<CombatCueKind, number> = {
  brush: 0.6, snowball: 1, push: 1, hit: 1, pole: 1, counter: 1, knockdown: 1, treeKnockout: 1
};

export function classifyCombat<R extends { knockedDown: boolean }>(
  events: ReadonlyArray<{ type: CueEvent['type']; rider: R }>,
  context: { counter: boolean; armed: boolean; thrown: ReadonlyArray<R> }
): Array<CombatCue<R>> {
  const cues: Array<CombatCue<R>> = [];
  const byRider = new Map<R, CombatCueKind>();
  for (const event of events) {
    let kind: CombatCueKind;
    if (event.type === 'knockout') kind = event.rider.knockedDown ? 'knockdown' : 'treeKnockout';
    else if (event.type === 'push') kind = 'push';
    else if (event.type === 'brush') kind = 'brush';
    else if (context.thrown.includes(event.rider)) kind = 'snowball';
    else if (context.counter) kind = 'counter';
    else kind = context.armed ? 'pole' : 'hit';
    const previous = byRider.get(event.rider);
    // A knockout outranks the hit that caused it.
    if (previous === undefined || CUE_WEIGHT[kind] >= CUE_WEIGHT[previous]) byRider.set(event.rider, kind);
  }
  byRider.forEach((kind, rider) => cues.push({ kind, rider }));
  return cues;
}
