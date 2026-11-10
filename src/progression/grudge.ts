import {
  GRUDGE_AGGRESSION_PER_LEVEL, GRUDGE_HITS_TO_ANGER, GRUDGE_HITS_TO_OWE, GRUDGE_INTERVAL_FACTOR, GRUDGE_MAX
} from '../config';
import type { AIRiderParams } from '../entities/aiRider';
import { PERSONALITIES, type RivalPersonality } from '../entities/personality';
import { integer, object } from './persistence';
import { hashIdentity } from './rules';

/** No Phaser here: the whole grudge model runs headlessly in verifyGrudges.
 * Grudges only exist inside a Cup; Drop In, Daily and Practice never build one. */
export type GrudgeLevel = 0 | 1 | 2;
export const GRUDGE_RIVAL_IDS = ['rival-0', 'rival-1', 'rival-2', 'rival-3'] as const;
export type GrudgeRivalId = typeof GRUDGE_RIVAL_IDS[number];

export interface GrudgeState {
  levels: Record<string, GrudgeLevel>;
  /** Rivals who beat you up last race: knock one down to cash the SETTLED bonus. */
  scores: string[];
  /** Rivals whose score was settled in the race just finished (drives the `settled` quote). */
  settled?: string[];
}
export interface RivalTally {
  /** Knockdowns, including a shove into a tree. */
  knockdowns: number;
  /** Deliberate hits (`hit` events: attack key, counters, snowballs). Shoves and body checks are not hits. */
  hits: number;
  /** Rival strikes that landed on the player. A hit the player's shield absorbed does not count. */
  hitsOnPlayer: number;
}
export interface RaceTally {
  rivals: Record<string, RivalTally>;
  /** Rivals whose score to settle was paid this race. */
  settled: string[];
}

export function emptyGrudges(): GrudgeState {
  return { levels: Object.fromEntries(GRUDGE_RIVAL_IDS.map(id => [id, 0 as GrudgeLevel])), scores: [], settled: [] };
}
export function emptyTally(): RaceTally {
  return { rivals: Object.fromEntries(GRUDGE_RIVAL_IDS.map(id => [id, { knockdowns: 0, hits: 0, hitsOnPlayer: 0 }])), settled: [] };
}
export function cloneGrudges(state: GrudgeState): GrudgeState {
  return { levels: { ...state.levels }, scores: [...state.scores], settled: [...(state.settled ?? [])] };
}
export function grudgeLevel(state: GrudgeState | null | undefined, id: string): GrudgeLevel {
  const level = state?.levels[id];
  return level === 1 || level === 2 ? level : 0;
}

/** Accepts anything, including a cup saved before grudges existed (-> empty). */
export function parseTally(value: unknown): RaceTally {
  const tally = emptyTally();
  if (!object(value)) return tally;
  if (object(value.rivals)) {
    for (const id of GRUDGE_RIVAL_IDS) {
      const raw = value.rivals[id];
      if (!object(raw)) continue;
      const count = (n: unknown): number => integer(n, 0, 999) ? n : 0;
      tally.rivals[id] = { knockdowns: count(raw.knockdowns), hits: count(raw.hits), hitsOnPlayer: count(raw.hitsOnPlayer) };
    }
  }
  if (Array.isArray(value.settled)) tally.settled = GRUDGE_RIVAL_IDS.filter(id => (value.settled as unknown[]).includes(id));
  return tally;
}

/**
 * The four rules, applied once per rival after a Cup race.
 *  - knocked it down (or into a tree) at least once, OR 3+ deliberate hits: level +1 (once per race, max GRUDGE_MAX)
 *  - it landed 2+ hits on you: you now have a score to settle with it
 *  - none of the above: level -1 (min 0). A race where it only beat you up leaves the level alone.
 * A SETTLED bonus paid this race clears the old score; a fresh score earned this race is still added.
 */
export function updateGrudges(previous: GrudgeState, tally: RaceTally): GrudgeState {
  const next = emptyGrudges();
  const owed = new Set(previous.scores.filter(id => !tally.settled.includes(id)));
  for (const id of GRUDGE_RIVAL_IDS) {
    const t = tally.rivals[id] ?? { knockdowns: 0, hits: 0, hitsOnPlayer: 0 };
    const level = grudgeLevel(previous, id);
    const angered = t.knockdowns >= 1 || t.hits >= GRUDGE_HITS_TO_ANGER;
    const beatYouUp = t.hitsOnPlayer >= GRUDGE_HITS_TO_OWE;
    if (beatYouUp) owed.add(id);
    next.levels[id] = (angered ? Math.min(GRUDGE_MAX, level + 1) : beatYouUp ? level : Math.max(0, level - 1)) as GrudgeLevel;
  }
  next.scores = GRUDGE_RIVAL_IDS.filter(id => owed.has(id));
  next.settled = GRUDGE_RIVAL_IDS.filter(id => tally.settled.includes(id));
  return next;
}

/** Rebuilds the grudge state from a cup's saved per-round tallies. Never trusts a saved `grudges` field. */
export function replayGrudges(tallies: readonly (RaceTally | undefined)[]): GrudgeState {
  return tallies.reduce<GrudgeState>((state, tally) => updateGrudges(state, tally ?? emptyTally()), emptyGrudges());
}

/** Per-race bookkeeping. The scene feeds it combat events; it never touches the sim. */
export class GrudgeTracker {
  readonly tally = emptyTally();
  /** Scores carried in from earlier races that have not been cashed yet this race. */
  private readonly pending: Set<string>;
  constructor(previous: GrudgeState) { this.pending = new Set(previous.scores); }
  hit(id: string): void { const t = this.tally.rivals[id]; if (t) t.hits++; }
  /** A rival strike that reached the player. `absorbed` (shield) means it did not land. */
  rivalHit(id: string, absorbed: boolean): void { const t = this.tally.rivals[id]; if (t && !absorbed) t.hitsOnPlayer++; }
  /** Returns true exactly once per rival with a score to settle: the SETTLED payout. */
  knockdown(id: string): boolean {
    const t = this.tally.rivals[id];
    if (!t) return false;
    t.knockdowns++;
    if (!this.pending.delete(id)) return false;
    this.tally.settled.push(id);
    return true;
  }
}

/** Harder rivals for a grudge level. Pure: level 0 returns an equal copy. */
export function applyGrudge(params: AIRiderParams, level: number): AIRiderParams {
  const steps = Math.max(0, Math.min(GRUDGE_MAX, Math.floor(level)));
  if (steps === 0) return { ...params };
  const baseInterval = params.attackIntervalMs ?? PERSONALITIES[params.personality ?? 'bully'].attackIntervalMs;
  return {
    ...params,
    aggression: Math.min(1, params.aggression + GRUDGE_AGGRESSION_PER_LEVEL * steps),
    attackIntervalMs: baseInterval * Math.pow(GRUDGE_INTERVAL_FACTOR, steps),
    grudgeLevel: steps
  };
}

/** One summary line for the result screen, or '' when nothing changed. */
export function grudgeSummary(previous: GrudgeState, next: GrudgeState, names: Record<string, string>): string {
  const risen = GRUDGE_RIVAL_IDS.filter(id => grudgeLevel(next, id) > grudgeLevel(previous, id));
  const owed = GRUDGE_RIVAL_IDS.filter(id => next.scores.includes(id) && !previous.scores.includes(id));
  const list = (ids: readonly string[]): string => ids.length <= 2 ? ids.map(id => names[id] ?? id).join(' and ') : `${ids.length} rivals`;
  const parts: string[] = [];
  if (risen.length) parts.push(`${list(risen)} won't forget that.`);
  if (owed.length) parts.push(`You owe ${list(owed)} one.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- taunts

export type TauntContext = 'grudge-1' | 'grudge-2' | 'player-owes' | 'neutral' | 'settled';
export const TAUNT_CONTEXTS: readonly TauntContext[] = ['grudge-1', 'grudge-2', 'player-owes', 'neutral', 'settled'];

/** Keep every line short: the Cup screen shows one at 10px beside a rider's name,
 * and the start-line banner fits one line well inside 960px. */
export const TAUNTS: Record<RivalPersonality, Record<TauntContext, readonly string[]>> = {
  bully: {
    'grudge-1': [
      'I felt that. You will feel the next one.',
      'Nice shove. Enjoy it while it lasts.',
      'Remember who owns this lane.',
      'You poked the bear. The bear noticed.'
    ],
    'grudge-2': [
      'You got lucky last time. Not twice.',
      'I have been waiting all day for this.',
      'This lane is mine. So is this race.',
      'Hope you wrote your goodbyes. Going in.'
    ],
    'player-owes': [
      'I put you in the snow. Come and get it.',
      'You owe me a lane and a little pride.',
      'Still dizzy? Good. I am just warming up.',
      'That was only the sample. Pay up.'
    ],
    neutral: [
      'Fresh snow, same bully. Stay out of my way.',
      'No hard feelings. Yet.',
      'Try to keep up, rookie.',
      'Let us see what you are made of.'
    ],
    settled: [
      'Fine. We are even. Do not get used to it.',
      'You got me. Once. Do not smile.',
      'Okay, that one stung. Debt paid.',
      'We are square. Now stay out of my way.'
    ]
  },
  'line-defender': {
    'grudge-1': [
      'That line was mine. I noticed.',
      'You cut me up. I keep a list.',
      'Next time, ask before you pass.',
      'I will be watching that lane. And you.'
    ],
    'grudge-2': [
      'You crossed my line twice. No third time.',
      'Every gate is mine now. Try me.',
      'I do not forget a trespasser.',
      'My line, my rules. Last warning.'
    ],
    'player-owes': [
      'I held my line. You paid for it.',
      'You owe me for that swing.',
      'Learn the lane or learn the snow.',
      'You bounced off me once. Try again.'
    ],
    neutral: [
      'Steady line, steady win.',
      'Take any lane you like. Just not mine.',
      'Slow and tidy beats fast and flat.',
      'I hold the line. You hold on.'
    ],
    settled: [
      'You broke my line. Fair enough.',
      'Well ridden. The books are balanced.',
      'Debt cleared. My line is still mine.',
      'Square at last. Back to guarding.'
    ]
  },
  daredevil: {
    'grudge-1': [
      'Oh, you want a show? I will give you one.',
      'You bumped my jump. Big mistake.',
      'I will remember that from way up high.',
      'Cute. Watch this next ramp.'
    ],
    'grudge-2': [
      'Now it is personal. Hold my goggles.',
      'You messed with the wrong flyer. Twice.',
      'I am coming down on you. From above.',
      'No brakes, no mercy, all grudge.'
    ],
    'player-owes': [
      'Told you the air is mine. Pay up.',
      'I clipped you mid-air. Want a rematch?',
      'You owe me a landing.',
      'Next jump, you get the sequel.'
    ],
    neutral: [
      'Rocks are ramps if you believe.',
      'See you in the air.',
      'Gravity is just a suggestion.',
      'Fast, high and a little reckless.'
    ],
    settled: [
      'Nice one! I still owe you a flip.',
      'You grounded me. Respect. Round two soon.',
      'Debt settled, adrenaline restored.',
      'Fair play. Now watch me soar.'
    ]
  }
};

/** Which quote applies to a rival right now. */
export function tauntContext(state: GrudgeState | null | undefined, rivalId: string): TauntContext {
  if (!state) return 'neutral';
  const level = grudgeLevel(state, rivalId);
  if (state.settled?.includes(rivalId)) return 'settled';
  if (level === 2) return 'grudge-2';
  if (state.scores.includes(rivalId)) return 'player-owes';
  return level === 1 ? 'grudge-1' : 'neutral';
}

/** Stable per cup, round and rival: the same inputs always pick the same line,
 * and a reload mid-cup shows the same quote. Never reads Math.random(). */
export function pickTaunt(cupId: string, roundIndex: number, rivalId: string, personality: RivalPersonality, context: TauntContext): string {
  const lines = TAUNTS[personality][context];
  return lines[hashIdentity(`${cupId}/${roundIndex}/${rivalId}`) % lines.length];
}

/** The rival whose taunt opens the race: highest level, then one with a score, then lowest index. null = nobody cares yet. */
export function bannerRival(state: GrudgeState | null | undefined): GrudgeRivalId | null {
  if (!state) return null;
  let best: GrudgeRivalId | null = null;
  let bestRank = 0;
  for (const id of GRUDGE_RIVAL_IDS) {
    const rank = grudgeLevel(state, id) * 2 + (state.scores.includes(id) ? 1 : 0);
    if (rank > bestRank) { best = id; bestRank = rank; }
  }
  return best;
}
